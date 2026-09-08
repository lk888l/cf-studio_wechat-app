let backgroundHandler: (() => void) | undefined;

export function onBackground(handler: () => void): () => void {
  backgroundHandler = handler;
  return () => {
    if (backgroundHandler === handler) backgroundHandler = undefined;
  };
}

export function enterBackground(): void {
  if (backgroundHandler) backgroundHandler();
}
