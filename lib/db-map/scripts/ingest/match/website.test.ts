import assert from "node:assert/strict";
import { test } from "node:test";
import { strongContactSignal, websiteIdentity } from "./denylist.js";

test("websites compare by full URL, never by shared domain", () => {
  // Distinct Forest Service campgrounds share fs.usda.gov.
  const a = "https://www.fs.usda.gov/recarea/mbs/recarea/?recid=17880";
  const b = "https://www.fs.usda.gov/recarea/mbs/recarea/?recid=18420";
  assert.equal(strongContactSignal(a, b, null, null).website, false);
  assert.equal(strongContactSignal(a, a, null, null).website, true);
  // www, scheme, trailing slash, case and tracking parameters do not matter.
  assert.equal(websiteIdentity("http://WWW.hpb.fi/?utm_source=x"), "hpb.fi");
  assert.equal(websiteIdentity("hpb.fi"), "hpb.fi");
  assert.equal(strongContactSignal("https://hpb.fi/", "http://www.hpb.fi", null, null).website, true);
  // Directory listing pages differ by path; denied hosts never identify.
  assert.equal(
    strongContactSignal(
      "https://biennialfoundation.org/biennials/vienna-biennale/",
      "https://biennialfoundation.org/biennials/klima-biennale-wien/",
      null,
      null,
    ).website,
    false,
  );
  assert.equal(websiteIdentity("https://facebook.com/somegarden"), null);
  assert.equal(websiteIdentity(""), null);
  assert.equal(websiteIdentity("not a url"), null);
  // A truncated escape (a real BGCI website) never throws; paths keep their case.
  assert.equal(
    websiteIdentity("https://www.northcentralcollege.edu/sites/default/files/documents/2017-10/Tree%2..."),
    "northcentralcollege.edu/sites/default/files/documents/2017-10/Tree%2...",
  );
  assert.equal(websiteIdentity("https://example.com/%ZZ"), "example.com/%ZZ");
  assert.equal(strongContactSignal("https://example.org/EventA", "https://example.org/eventa", null, null).website, false);
  assert.equal(websiteIdentity("HTTPS://Example.ORG/EventA/"), "example.org/EventA");
});
