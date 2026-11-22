import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { PARSERS, dedupeKey } from "../supabase/functions/sync-mail/parsers.ts";

const fx = (n: string) => readFileSync(`./tests/fixtures/${n}`, "utf8");
const li = PARSERS.linkedin, cs = PARSERS.cutshort;

// LinkedIn digest
let m = { sender: "jobalerts-noreply@linkedin.com", subject: "U.S. Bank is hiring a Senior Digital Product Manager", text: fx("li_digest.txt") };
assert.equal(li.classify(m).kind, "alert");
let r = li.parse(m);
assert.equal(r.jobs.length, 3); assert.equal(r.dropped, 0);
assert.deepEqual([r.jobs[0].title, r.jobs[0].company, r.jobs[0].location], ["Senior Digital Product Manager", "U.S. Bank", "Chennai"]);
assert.equal(r.jobs[0].job_url, "https://www.linkedin.com/jobs/view/4484983589");
assert.deepEqual([r.jobs[1].title, r.jobs[1].company], ["Senior Product Owner, BI & Analytics", "Danfoss"]);
assert.equal(r.jobs[2].company, "Rocket India");
assert.equal(dedupeKey("linkedin", r.jobs[0]), "linkedin:4484983589");

// LinkedIn recommendations (jobs-noreply), no note line
m = { sender: "jobs-noreply@linkedin.com", subject: "NETGEAR is hiring for Product Manager", text: fx("li_reco.txt") };
assert.equal(li.classify(m).kind, "alert");
r = li.parse(m);
assert.equal(r.jobs.length, 2);
assert.deepEqual([r.jobs[0].title, r.jobs[0].company, r.jobs[0].location], ["Product Manager", "NETGEAR", "Chennai"]);
assert.deepEqual([r.jobs[1].title, r.jobs[1].company, r.jobs[1].location], ["Director, Product Management - Platforms", "Gigamon", "Guindy"]);

// Application confirmation is skipped
assert.equal(li.classify({ sender: "jobs-noreply@linkedin.com", subject: "Your application to Senior Product Manager, Warranty at Porch Group", text: fx("li_reco.txt") }).kind, "not_alert");
// Mail with no listings is skipped
assert.equal(li.classify({ sender: "jobs-noreply@linkedin.com", subject: "hello", text: "nothing here" }).kind, "not_alert");

// Cutshort
m = { sender: "notify@cutshort.io", subject: "Scan these 2 fresh opportunities in 2 mins", text: fx("cutshort.txt") };
assert.equal(cs.classify(m).kind, "alert");
r = cs.parse(m);
assert.equal(r.jobs.length, 2);
assert.deepEqual([r.jobs[0].title, r.jobs[0].company, r.jobs[0].location], ["Product Manager", "Fx31labs", "MEXICO CITY (Mexico)"]);
assert.deepEqual([r.jobs[1].title, r.jobs[1].company, r.jobs[1].location], ["Senior Product Manager (B2C growth and retention)", "Habuild", "Bengaluru (Bangalore)"]);
assert.equal(r.jobs[0].job_url, "https://cutshort.io/job/Product-Manager-MEXICO-CITY-Mexico-Fx31labs-HX0sl4gD");
assert.equal(r.jobs[0].external_job_id, "HX0sl4gD");
console.log("all parser tests passed");
