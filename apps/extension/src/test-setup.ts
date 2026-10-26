// Extension storage for tests: an in-memory fake that tests share with the code under test.
import "@webext-core/fake-browser/auto";
// Binds wxt storage to the fake before any test replaces `chrome` with its own stubs.
import "@wxt-dev/storage";

import { fakeBrowser } from "@webext-core/fake-browser";
import { beforeEach } from "vite-plus/test";

beforeEach(() => fakeBrowser.reset());
