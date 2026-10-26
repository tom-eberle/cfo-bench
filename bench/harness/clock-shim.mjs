// Pins the clock of the compta CLI process to the scenario's "today" (FRENCH_CFO_BENCH_NOW, ISO date).
// The clock is shifted, not frozen: time still advances during a run, so timeouts and elapsed
// times behave normally. The CLI itself is not modified; it is loaded with `node --import`.
const target = Date.parse(`${process.env.FRENCH_CFO_BENCH_NOW ?? ''}T09:00:00Z`);
if (Number.isFinite(target)) {
  const RealDate = Date;
  const offset = target - RealDate.now();
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  }
  globalThis.Date = ShiftedDate;
}
