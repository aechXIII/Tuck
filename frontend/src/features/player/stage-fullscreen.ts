import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** The desktop window's own full screen, for when the page can't use element fullscreen. */
export interface WindowFullscreen {
  /** puts the window in or out of full screen and answers whether it already was */
  set: (fullscreen: boolean) => Promise<boolean>;
  /** calls back whenever the window enters or leaves full screen, by Tuck or by the desktop */
  watch: (listener: (fullscreen: boolean) => void) => void;
}

export interface StageFullscreen {
  toggle: () => void;
}

type StageDocument = Pick<
  Document,
  "documentElement" | "fullscreenElement" | "exitFullscreen" | "addEventListener" | "removeEventListener"
>;

export function tauriWindowFullscreen(): WindowFullscreen {
  return {
    set: (fullscreen) => invoke<boolean>("set_window_fullscreen", { fullscreen }),
    watch: (listener) => {
      void listen<boolean>("window-fullscreen", (event) => listener(event.payload === true));
    },
  };
}

/**
 * Fills the screen with the player. Where the webview supports element fullscreen the player's
 * card goes full screen; otherwise the window goes full screen and `stage-fullscreen` on the root
 * lets the card cover the editor.
 */
export function createStageFullscreen(options: {
  doc: StageDocument;
  center: () => HTMLElement | null;
  /** whether the webview's element fullscreen can be used */
  elementFullscreen: () => Promise<boolean>;
  window: WindowFullscreen | null;
}): StageFullscreen {
  const { doc } = options;
  const root = doc.documentElement;
  let element: boolean | null = null;
  void options.elementFullscreen().then((value) => {
    element = value;
  });
  let staged = false;
  // a window the desktop had already made full screen stays that way when the player leaves
  let keepWindow = false;
  // the desktop's answer to an earlier change can arrive while a newer one is on its way
  let changing = 0;

  const changeWindow = (shell: WindowFullscreen, fullscreen: boolean): Promise<boolean> => {
    changing++;
    return shell.set(fullscreen).finally(() => {
      changing--;
    });
  };

  // like the webview's own fullscreen, Escape leaves before anything else sees the key
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    leave(true);
  };

  const setStaged = (on: boolean): void => {
    staged = on;
    root.classList.toggle("stage-fullscreen", on);
    if (on) doc.addEventListener("keydown", onKey, true);
    else doc.removeEventListener("keydown", onKey, true);
  };

  const enter = (shell: WindowFullscreen): void => {
    setStaged(true);
    changeWindow(shell, true).then(
      (wasFullscreen) => {
        keepWindow = wasFullscreen;
      },
      (error: unknown) => {
        setStaged(false);
        console.error("Could not make the window full screen", error);
      },
    );
  };

  function leave(restoreWindow: boolean): void {
    if (!staged) return;
    setStaged(false);
    const shell = options.window;
    if (!restoreWindow || keepWindow || !shell) return;
    changeWindow(shell, false).catch((error: unknown) => {
      console.error("Could not leave full screen", error);
    });
  }

  options.window?.watch((fullscreen) => {
    if (!fullscreen && changing === 0) leave(false);
  });

  const toggleElement = (): void => {
    if (doc.fullscreenElement) {
      void doc.exitFullscreen();
      return;
    }
    const center = options.center();
    if (center?.requestFullscreen) void center.requestFullscreen();
  };

  const toggleWith = (useElement: boolean): void => {
    const shell = options.window;
    if (useElement || !shell) toggleElement();
    else enter(shell);
  };

  return {
    toggle() {
      if (staged) {
        leave(true);
        return;
      }
      if (element !== null) toggleWith(element);
      else void options.elementFullscreen().then(toggleWith);
    },
  };
}
