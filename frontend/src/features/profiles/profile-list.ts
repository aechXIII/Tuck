export interface ProfileListEntry {
  readonly profile_id?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface ProfileListOptions {
  defaultProfileId?: string;
  summarize: (profile: ProfileListEntry) => string;
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
    const row = create(documentRef, "div", "settings-list-row");
    const main = create(documentRef, "div", "settings-list-main");
    main.appendChild(create(documentRef, "strong", "", profile.name ?? ""));
    main.appendChild(create(documentRef, "span", "", options.summarize(profile)));
    if (profile.profile_id === options.defaultProfileId) {
      main.appendChild(create(documentRef, "span", "settings-badge", "Default"));
    }
    row.appendChild(main);
    row.appendChild(actionButton(documentRef, "Edit", "edit", profile, "btn2"));

    const details = create(documentRef, "details", "profile-actions-menu");
    const summary = create(documentRef, "summary", "mbtn", "•••");
    summary.setAttribute("aria-label", `More actions for ${String(profile.name ?? "")}`);
    details.appendChild(summary);
    const popover = create(documentRef, "div", "profile-actions-popover");
    popover.appendChild(actionButton(documentRef, "Export", "export", profile));
    popover.appendChild(actionButton(documentRef, "Duplicate", "duplicate", profile));
    popover.appendChild(actionButton(documentRef, "Delete", "delete", profile, "danger"));
    details.appendChild(popover);
    row.appendChild(details);
    list.appendChild(row);
  }
  if (!profiles.length) {
    list.appendChild(create(documentRef, "div", "settings-empty", "No matching profiles."));
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
  list.appendChild(
    shortcutChoice(documentRef, "Tuck", "Default shortcut", "install-generic-shortcut", {}),
  );
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
    binding.callback(selected.action, selected.profileId, selected.profileName);
  });
}
