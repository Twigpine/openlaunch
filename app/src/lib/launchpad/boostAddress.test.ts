import { test } from "node:test";
import assert from "node:assert/strict";
import { boostClickAddress } from "./boostAddress.ts";

test("IPv4 is the address itself", () => {
  assert.equal(boostClickAddress("203.0.113.7"), "203.0.113.7");
  assert.equal(boostClickAddress(" 203.0.113.7 "), "203.0.113.7");
  assert.equal(boostClickAddress("0.0.0.0"), "0.0.0.0");
});

test("IPv6 is its /64 however it is written: a new host in one's own block adds nothing", () => {
  const block = "2001:db8:abcd:12::/64";
  for (const ip of ["2001:db8:abcd:12::1", "2001:0db8:abcd:0012:ffff:1:2:3", "2001:DB8:ABCD:12:0:0:0:9", "[2001:db8:abcd:12::77]", "2001:db8:abcd:12::1%eth0", "2001:db8:abcd:12::203.0.113.7"]) {
    assert.equal(boostClickAddress(ip), block, ip);
  }
  assert.notEqual(boostClickAddress("2001:db8:abcd:13::1"), block, "the next /64 is another key");
  assert.equal(boostClickAddress("2001:db8::1"), "2001:db8:0:0::/64", "compressed zeros in the network half are expanded first");
  assert.equal(boostClickAddress("::1"), "0:0:0:0::/64");
  assert.equal(boostClickAddress("::"), "0:0:0:0::/64");
});

test("an IPv4 client seen through IPv6 keeps its own IPv4 key, written dotted or in hex", () => {
  for (const ip of ["::ffff:203.0.113.7", "0:0:0:0:0:ffff:203.0.113.7", "::ffff:cb00:7107", "0:0:0:0:0:FFFF:CB00:7107", "[::ffff:cb00:7107]"]) {
    assert.equal(boostClickAddress(ip), "203.0.113.7", ip);
  }
  // two different IPv4 clients in hex form never share a key (the bug: both fell into 0:0:0:0::/64)
  assert.equal(boostClickAddress("::ffff:c633:6401"), "198.51.100.1");
  assert.notEqual(boostClickAddress("::ffff:cb00:7107"), boostClickAddress("::ffff:c633:6401"));
  // only ::ffff:0:0/96 is mapped: ::fffe:… or a /96 with other leading bits is plain IPv6
  assert.equal(boostClickAddress("::fffe:cb00:7107"), "0:0:0:0::/64");
  assert.equal(boostClickAddress("1::ffff:cb00:7107"), "1:0:0:0::/64");
});

test("anything that is not an address is its own key, never a crash", () => {
  for (const s of ["1::2::3", "not an ip", "", "203.0.113.7:443", "999.1.1.1", "2001:db8::g"]) {
    assert.equal(boostClickAddress(s), s.trim().toLowerCase(), JSON.stringify(s));
  }
});
