import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Store } from "../store/store.ts";
import { createScheduleTools, type ScheduleEvent, schedulesPromptSection } from "./schedule.ts";

function tools(opts: { max?: number; conversationKey?: string } = {}) {
  const store = new Store(":memory:");
  const events: ScheduleEvent[] = [];
  const [schedule, listSchedules, unschedule] = createScheduleTools({
    store,
    max: opts.max ?? 20,
    conversationKey: opts.conversationKey,
    onEvent: (e) => events.push(e),
  });
  return { store, events, schedule, listSchedules, unschedule };
}

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();

Deno.test("schedule: a recurring cron row, tied to the creating conversation", async () => {
  const { store, events, schedule } = tools({ conversationKey: "discord:42" });
  const reply = await schedule.execute(
    JSON.stringify({
      prompt: "post the standup",
      cron: "0 9 * * 1-5",
      timezone: "Africa/Johannesburg",
    }),
  );
  assertStringIncludes(reply, "scheduled #1 — next ");

  const [row] = store.listSchedules();
  assertEquals(row.cron, "0 9 * * 1-5");
  assertEquals(row.timezone, "Africa/Johannesburg");
  assertEquals(row.conversationKey, "discord:42");
  assertEquals(events.length, 1);
  assertEquals(events[0].action, "create");
  store.close();
});

Deno.test("schedule: a one-shot at a future timestamp", async () => {
  const { store, schedule } = tools();
  const reply = await schedule.execute(JSON.stringify({ prompt: "remind: renew", at: FUTURE }));
  assertStringIncludes(reply, "fires ");
  assertEquals(store.listSchedules()[0].at, FUTURE);
  assertEquals(store.listSchedules()[0].conversationKey, undefined);
  store.close();
});

Deno.test("schedule: refusals — both kinds, neither kind, seconds, bad pattern, past", async () => {
  const { store, schedule } = tools();
  const run = (args: Record<string, unknown>) => schedule.execute(JSON.stringify(args));

  assertStringIncludes(await run({ prompt: "p" }), "exactly one of");
  assertStringIncludes(await run({ prompt: "p", cron: "* * * * *", at: FUTURE }), "exactly one of");
  assertStringIncludes(await run({ prompt: "p", cron: "*/5 * * * * *" }), "one minute");
  assertStringIncludes(await run({ prompt: "p", cron: "not a pattern" }), "invalid cron");
  assertStringIncludes(await run({ prompt: "p", at: "2001-01-01T00:00:00Z" }), "in the past");
  assertStringIncludes(await run({ prompt: "p", at: "whenever" }), "not an ISO 8601");
  assertEquals(store.countSchedules(), 0); // every refusal left no row
  store.close();
});

Deno.test("schedule: the cap refuses and points at unschedule", async () => {
  const { store, events, schedule, unschedule } = tools({ max: 1 });
  await schedule.execute(JSON.stringify({ prompt: "one", cron: "0 9 * * *" }));
  const refused = await schedule.execute(JSON.stringify({ prompt: "two", cron: "0 10 * * *" }));
  assertStringIncludes(refused, "schedule limit reached (1)");
  assertEquals(store.countSchedules(), 1);

  assertEquals(await unschedule.execute(JSON.stringify({ id: 1 })), "unscheduled #1");
  assertEquals(events.at(-1)?.action, "cancel");
  assertStringIncludes(
    await schedule.execute(JSON.stringify({ prompt: "two", cron: "0 10 * * *" })),
    "scheduled #",
  );
  store.close();
});

Deno.test("list_schedules and unschedule round-trip", async () => {
  const { schedule, listSchedules, unschedule } = tools({ conversationKey: "telegram:7" });
  assertEquals(await listSchedules.execute("{}"), "no schedules held");
  await schedule.execute(JSON.stringify({ prompt: "daily digest", cron: "0 8 * * *" }));
  await schedule.execute(JSON.stringify({ prompt: "remind: dentist", at: FUTURE }));

  const listed = await listSchedules.execute("{}");
  assertStringIncludes(listed, '#1 cron "0 8 * * *" -> telegram:7: daily digest');
  assertStringIncludes(listed, `#2 once at ${FUTURE} -> telegram:7: remind: dentist`);

  assertEquals(await unschedule.execute(JSON.stringify({ id: 3 })), "no schedule #3");
  assertEquals(await unschedule.execute(JSON.stringify({ id: 2 })), "unscheduled #2");
  assert(!(await listSchedules.execute("{}")).includes("dentist"));
});

Deno.test("schedulesPromptSection names the tools and the budget", () => {
  const section = schedulesPromptSection(3, 20);
  assertStringIncludes(section, "schedule");
  assertStringIncludes(section, "unschedule");
  assertStringIncludes(section, "3 of 20");
});
