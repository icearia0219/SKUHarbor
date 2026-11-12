export function killWindowsProcessTree(
  childPid: number,
  bashPath?: string,
): boolean;
export function prepareWindowsBashCommand(command: string): string;
export const windowsBashCommandPrefix: string;
