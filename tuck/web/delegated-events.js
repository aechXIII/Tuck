(function (root) {
  "use strict";

  function findActionTarget(container, target, datasetKey) {
    var selected = null;
    var eventTarget = target;
    while (target) {
      if (target === container) {
        if (
          !selected &&
          target === eventTarget &&
          target.dataset &&
          target.dataset[datasetKey]
        ) {
          selected = target;
        }
        return selected;
      }
      if (!selected && target.dataset && target.dataset[datasetKey]) {
        selected = target;
      }
      target = target.parentElement;
    }
    return null;
  }

  function bind(container, handlers, namespace) {
    var prefix = namespace || "action";
    var eventAttributes = {
      click: prefix + "Click",
      input: prefix + "Input",
      change: prefix + "Change",
    };
    Object.keys(eventAttributes).forEach(function (eventType) {
      container.addEventListener(eventType, function (event) {
        var datasetKey = eventAttributes[eventType];
        var target = findActionTarget(container, event.target, datasetKey);
        if (!target) return;
        var actionName = target.dataset[datasetKey];
        var handler = handlers[eventType] && handlers[eventType][actionName];
        if (!handler) return;
        if (eventType === "click" && event.preventDefault) event.preventDefault();
        handler(target, event);
      });
    });
  }

  function createRegistry(container) {
    var handlers = { click: {}, input: {}, change: {} };
    bind(container, handlers);
    return {
      register: function (eventType, actions) {
        var owned = handlers[eventType];
        if (!owned) throw new Error("Unsupported delegated event: " + eventType);
        Object.keys(actions).forEach(function (actionName) {
          if (Object.prototype.hasOwnProperty.call(owned, actionName)) {
            throw new Error("Action already registered: " + actionName);
          }
          owned[actionName] = actions[actionName];
        });
      },
    };
  }

  var api = { bind: bind, createRegistry: createRegistry };
  if (root) {
    root.Tuck = root.Tuck || {};
    root.Tuck.delegatedEvents = api;
    if (root.document && root.document.body) {
      root.Tuck.uiEvents = createRegistry(root.document.body);
    }
  }
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
