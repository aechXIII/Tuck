export interface ProfileListEntry {
  readonly profile_id?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface ProfileListOptions {
  defaultProfileId?: string;
  summarize: (profile: ProfileListEntry) => string;
  /** shown in place of rows when there are none */
  empty?: string;
  /** profiles listed first in the profile picker */
  pinned?: ReadonlySet<string>;
  /** profiles left out of the profile picker */
  hidden?: ReadonlySet<string>;
}

export interface ShortcutChoiceOptions {
  summarize: (profile: ProfileListEntry) => string;
}

export type ProfileActionCallback = (
  action: string,
  profileId: string,
  profileName: string,
) => void;

const bindings = new WeakMap<HTMLElement, { callback: ProfileActionCallback }>();

function create(
  documentRef: Document,
  tagName: string,
  className?: string,
  content?: string,
): HTMLElement {
  const element = documentRef.createElement(tagName);
  if (className) element.className = className;
  if (content !== undefined) element.textContent = content;
  return element;
}

function actionButton(
  documentRef: Document,
  label: string,
  action: string,
  profile: ProfileListEntry,
  className?: string,
): HTMLButtonElement {
  const button = create(documentRef, "button", className ?? "", label) as HTMLButtonElement;
  button.type = "button";
  button.dataset.profileAction = action;
  button.dataset.profileId = String(profile.profile_id ?? "");
  button.dataset.profileName = String(profile.name ?? "");
  return button;
}

export function renderProfileList(
  documentRef: Document,
  list: HTMLElement,
  profiles: readonly ProfileListEntry[],
  options: ProfileListOptions,
): void {
  list.replaceChildren();
  for (const profile of profiles) {
    const name = String(profile.name ?? "");
    const id = String(profile.profile_id ?? "");
    const isDefault = id === options.defaultProfileId;
    const pinned = options.pinned?.has(id) ?? false;
    const hidden = options.hidden?.has(id) ?? false;
    const row = create(documentRef, "div", "set-row set-profile-row");
    row.setAttribute("role", "listitem");

    // the whole row opens the editor; the menu holds everything else
    const main = actionButton(documentRef, "", "edit", profile, "set-profile-main");
    main.setAttribute("aria-label", `Edit ${name}`);
    const title = create(documentRef, "span", "set-profile-title");
    title.appendChild(create(documentRef, "span", "set-label", name));
    if (isDefault) title.appendChild(create(documentRef, "span", "set-tag default", "Default"));
    if (pinned) title.appendChild(create(documentRef, "span", "set-tag", "Pinned"));
    if (hidden) title.appendChild(create(documentRef, "span", "set-tag", "Hidden"));
    main.appendChild(title);
    main.appendChild(create(documentRef, "span", "set-desc", options.summarize(profile)));
    row.appendChild(main);

    const details = create(documentRef, "details", "profile-actions-menu");
    const summary = create(documentRef, "summary", "set-icon-btn", "⋯");
    summary.setAttribute("aria-label", `More actions for ${name}`);
    details.appendChild(summary);
    const popover = create(documentRef, "div", "profile-actions-popover");
    popover.setAttribute("role", "menu");
    const items = [
      actionButton(documentRef, "Edit", "edit", profile),
      actionButton(documentRef, "Duplicate", "duplicate", profile),
      ...(isDefault ? [] : [actionButton(documentRef, "Set as default", "default", profile)]),
      pinned
        ? actionButton(documentRef, "Unpin", "unpin", profile)
        : actionButton(documentRef, "Pin to top of picker", "pin", profile),
      hidden
        ? actionButton(documentRef, "Show in picker", "show", profile)
        : actionButton(documentRef, "Hide from picker", "hide", profile),
      actionButton(documentRef, "Export…", "export", profile),
      actionButton(documentRef, "Delete", "delete", profile, "danger"),
    ];
    for (const item of items) {
      item.setAttribute("role", "menuitem");
      popover.appendChild(item);
    }
    details.appendChild(popover);
    row.appendChild(details);
    list.appendChild(row);
  }
  if (!profiles.length) {
    list.appendChild(create(documentRef, "p", "set-empty in-card", options.empty ?? "No matching profiles."));
  }
}

function shortcutChoice(
  documentRef: Document,
  title: string,
  description: string,
  action: string,
  profile: ProfileListEntry,
): HTMLButtonElement {
  const button = actionButton(documentRef, "", action, profile, "mrow");
  const info = create(documentRef, "div", "mi");
  info.appendChild(create(documentRef, "div", "mti", title));
  info.appendChild(create(documentRef, "div", "mme", description));
  button.appendChild(info);
  return button;
}

export function renderShortcutChoices(
  documentRef: Document,
  list: HTMLElement,
  profiles: readonly ProfileListEntry[],
  options: ShortcutChoiceOptions,
): void {
  list.replaceChildren();
  for (const profile of profiles) {
    list.appendChild(
      shortcutChoice(
        documentRef,
        profile.name ?? "",
        options.summarize(profile),
        "install-profile-shortcut",
        profile,
      ),
    );
  }
}

interface DatasetNode {
  dataset?: Record<string, string | undefined>;
  parentElement?: DatasetNode | null;
}

function actionFromTarget(
  target: unknown,
  container: unknown,
): { action: string; profileId: string; profileName: string } | null {
  let node = target as DatasetNode | null;
  while (node && node !== container) {
    const action = node.dataset?.profileAction;
    if (action) {
      return {
        action,
        profileId: node.dataset?.profileId ?? "",
        profileName: node.dataset?.profileName ?? "",
      };
    }
    node = node.parentElement ?? null;
  }
  return null;
}

export function bindProfileActions(
  container: HTMLElement,
  callback: ProfileActionCallback,
): void {
  const existing = bindings.get(container);
  if (existing) {
    existing.callback = callback;
    return;
  }
  const binding = { callback };
  bindings.set(container, binding);
  container.addEventListener("click", (event) => {
    const selected = actionFromTarget(event.target, container);
    if (!selected) return;
    // a chosen menu item closes its menu and hands focus back to the menu button, so a
    // confirmation that follows returns there instead of to a hidden item
    const target = event.target as { closest?: (selector: string) => Element | null } | null;
    const menu = target?.closest?.("details[open]");
    if (menu) {
      menu.removeAttribute("open");
      (menu.querySelector("summary") as HTMLElement | null)?.focus();
    }
    binding.callback(selected.action, selected.profileId, selected.profileName);
  });
}

/**
 * The profiles the editor's picker offers, pinned ones first in the order they were pinned.
 * Hidden profiles are left out, except the one in use, and hiding every profile hides none.
 */
export function pickerProfiles<T extends ProfileListEntry>(
  profiles: readonly T[],
  pinned: readonly string[],
  hidden: readonly string[],
  inUse: string,
): T[] {
  const hiddenIds = new Set(hidden);
  const id = (profile: T): string => String(profile.profile_id ?? "");
  let shown = profiles.filter((profile) => !hiddenIds.has(id(profile)) || id(profile) === inUse);
  if (!shown.length) shown = [...profiles];
  const rank = (profile: T): number => {
    const index = pinned.indexOf(id(profile));
    return index < 0 ? pinned.length : index;
  };
  return shown
    .map((profile, index) => ({ profile, index }))
    .sort((a, b) => rank(a.profile) - rank(b.profile) || a.index - b.index)
    .map((entry) => entry.profile);
}
