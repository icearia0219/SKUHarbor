import robotIconUrl from '../../../assets/miniclaw-icon.svg?no-inline';

// Vite fingerprints the approved robot, so cached legacy PNGs cannot replace it.
export const appIconUrl = robotIconUrl;
export const appNotificationIconUrl = `${import.meta.env.BASE_URL}icons/icon-192.png?v=${encodeURIComponent(robotIconUrl)}`;

export const APP_NAME = 'SKUHarbor';
export const PROJECT_REPOSITORY = 'icearia0219/SKUHarbor';
export const PROJECT_URL = `https://github.com/${PROJECT_REPOSITORY}`;

/** Presentation only. Keep persisted compatibility keys and custom site names. */
export function productAppName(name?: string | null): string {
  return !name || ['OpenDot', 'Miniclaw', 'MiniClaw'].includes(name)
    ? APP_NAME
    : name;
}
