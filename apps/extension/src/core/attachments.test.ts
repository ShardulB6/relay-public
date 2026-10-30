import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, test } from "vite-plus/test";

import { Attachments } from "./attachments.ts";
import { chromeStore } from "./storage.ts";

const id = 1 as ConversationId;
const pdf = (name: string, text = name) => new File([text], name, { type: "application/pdf" });

test("a file attached again under a taken name is stored beside it, not over it", async () => {
  const attachments = new Attachments(chromeStore("attachments"));
  expect(await attachments.save(id, [pdf("resume.pdf", "first")])).toEqual(["resume.pdf"]);
  expect(await attachments.save(id, [pdf("resume.pdf", "second"), pdf("resume.pdf")])).toEqual([
    "resume (2).pdf",
    "resume (3).pdf",
  ]);

  expect(await (await attachments.get(id, "resume.pdf"))?.text()).toBe("first");
  const second = await attachments.get(id, "resume (2).pdf");
  expect(second?.type).toBe("application/pdf");
  expect(await second?.text()).toBe("second");
});

test("saves and deletes that overlap apply in order", async () => {
  const attachments = new Attachments(chromeStore("attachments"));
  await Promise.all([attachments.save(id, [pdf("a.pdf")]), attachments.save(id, [pdf("b.pdf")])]);
  expect(await attachments.names(id)).toEqual(["a.pdf", "b.pdf"]);

  // A delete made while a save is under way is not undone by it.
  const saving = attachments.save(id, [pdf("c.pdf")]);
  await Promise.all([saving, attachments.delete(id)]);
  expect(await attachments.names(id)).toEqual([]);
});
