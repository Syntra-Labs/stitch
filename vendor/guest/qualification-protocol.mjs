// A byte-at-a-time kernel '#1' banner is not an interactive shell prompt.
export function guestShellReady(text) {
  return /(?:^|[\r\n])(?:\/[^\r\n]* )?# $/.test(text);
}
