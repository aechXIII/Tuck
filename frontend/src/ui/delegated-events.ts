export type DelegatedEventType = "click" | "input" | "change";
export type DelegatedHandler = (target: HTMLElement, event: Event) => void;
export type DelegatedHandlers = Partial<Record<DelegatedEventType, Record<string, DelegatedHandler>>>;

function isHtmlElement(value: EventTarget | null): value is HTMLElement {
  return typeof HTMLElement === "undefined"
    ? Boolean(value && typeof value === "object" && "dataset" in value && "parentElement" in value)
    : value instanceof HTMLElement;
}

function isElementLike(value: EventTarget | null): value is Element {
  return typeof Element === "undefined"
    ? isHtmlElement(value)
    : value instanceof Element;
}

function findActionTarget(container: HTMLElement, eventTarget: EventTarget | null, datasetKey: string): HTMLElement | null {
  let target = isElementLike(eventTarget) ? eventTarget : null;
  const initial = target;
  let selected: HTMLElement | null = null;
  while (target) {
    if (target === container)
      return selected ??
        (target === initial && isHtmlElement(target) && target.dataset[datasetKey] ? target : null);
    if (!selected && isHtmlElement(target) && target.dataset[datasetKey]) selected = target;
    target = target.parentElement;
  }
  return null;
}

export function bindDelegatedEvents(container: HTMLElement, handlers: DelegatedHandlers, namespace = "action"): void {
  const attributes: Readonly<Record<DelegatedEventType, string>> = {
    click: `${namespace}Click`, input: `${namespace}Input`, change: `${namespace}Change`,
  };
  for (const eventType of Object.keys(attributes) as DelegatedEventType[]) {
    container.addEventListener(eventType, (event) => {
      const target = findActionTarget(container, event.target, attributes[eventType]);
      const action = target?.dataset[attributes[eventType]];
      const handler = action ? handlers[eventType]?.[action] : undefined;
      if (!target || !handler) return;
      if (eventType === "click") event.preventDefault();
      handler(target, event);
    });
  }
}

export interface DelegatedEventRegistry { register(eventType: DelegatedEventType, actions: Record<string, DelegatedHandler>): void; }
export function createDelegatedEventRegistry(container: HTMLElement): DelegatedEventRegistry {
  const handlers: Required<DelegatedHandlers> = { click: {}, input: {}, change: {} };
  bindDelegatedEvents(container, handlers);
  return { register(eventType, actions): void {
    const owned = handlers[eventType];
    for (const [name, handler] of Object.entries(actions)) {
      if (Object.hasOwn(owned, name)) throw new Error(`Action already registered: ${name}`);
      owned[name] = handler;
    }
  } };
}

export { bindDelegatedEvents as bind, createDelegatedEventRegistry as createRegistry };
