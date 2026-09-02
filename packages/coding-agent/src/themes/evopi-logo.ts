/**
 * Pre-rendered ASCII landing mark for evopi.
 *
 * A bold "EVO" wordmark — the evolutionary core of the harness — framed by an
 * ascending chevron above (the evolve-and-iterate motion) and an iteration
 * baseline below. Single-width glyphs only (▄ █ ▀) so it aligns in any
 * monospace terminal.
 */

/** ~10 rows, ≤32 cols. The default splash mark. Keep in sync with install.sh evopi_logo_line(). */
export const EVOPI_LOGO = `              ▄▄▄
            ▄█▀ ▀█▄

       ████  █   █   ███
       █     █   █  █   █
       ███   █   █  █   █
       █      █ █   █   █
       ████    █     ███

          ▀▀▀▀   ▀▀▀▀`;
