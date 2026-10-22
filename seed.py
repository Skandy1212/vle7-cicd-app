#!/usr/bin/env python3
"""Seed demo accounts and student records (with age, gender, course, year, residence) through the real
gateway API until every shard holds about PER_SHARD records. Safe to re-run: accounts that already have
records are not duplicated, and old records without the new fields get them filled in.

  DEMO_PW='<a 6+ char password you choose>' python3 seed.py
Optional env: GW=http://localhost:30080 SHARDS=2 PER_SHARD=25 PER_ACCOUNT=5
"""
import json, os, random, sys, urllib.request, urllib.error, http.cookiejar

GW = os.environ.get("GW", "http://localhost:30080").rstrip("/")
SHARDS = int(os.environ.get("SHARDS", "2"))
PER_SHARD = int(os.environ.get("PER_SHARD", "25"))
PER_ACCOUNT = int(os.environ.get("PER_ACCOUNT", "5"))
PW = os.environ.get("DEMO_PW", "")
if len(PW) < 6:
    sys.exit("Set DEMO_PW (6+ characters), e.g.  DEMO_PW='something-you-choose' python3 seed.py")

rnd = random.Random(2311)
FIRST = "Aarav Diya Rohan Ananya Karthik Meera Vikram Sneha Arjun Priya Rahul Kavya Aditya Ishita Nikhil Pooja Sanjay Lakshmi Varun Divya Harish Nandini Manoj Swati Deepak Revathi Gokul Anjali Tarun Bhavna".split()
LAST = "Kumar Sharma Iyer Nair Reddy Patel Menon Das Rao Singh Pillai Gupta Krishnan Verma Shetty".split()
COURSES = [("CSE", 30), ("IT", 15), ("AI & DS", 15), ("ECE", 15), ("EEE", 8), ("Mechanical", 10), ("Civil", 7)]
GENDERS = [("Female", 46), ("Male", 50), ("Other", 4)]

def pick(pairs):
    return rnd.choices([p[0] for p in pairs], weights=[p[1] for p in pairs])[0]

def clip(v, lo=0, hi=100):
    return round(max(lo, min(hi, v)), 1)

def profile():
    year = rnd.randint(1, 4)
    marks = clip(rnd.gauss(66, 15))
    return {
        "age": max(16, min(40, 17 + year + rnd.choice([0, 0, 1, 1, 2]))),
        "gender": pick(GENDERS), "course": pick(COURSES), "year": year,
        "residence": "Hostel" if rnd.random() < 0.6 else "Day scholar",
        "marks": marks, "attendance": clip(rnd.gauss(60 + marks * 0.3, 9)),
    }

class Session:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def call(self, method, path, body=None):
        req = urllib.request.Request(GW + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"content-type": "application/json"})
        try:
            with self.op.open(req, timeout=15) as r:
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            try: return e.code, json.loads(e.read() or b"{}")
            except Exception: return e.code, {}

counts = {}
serial = 0
for n in range(1, 61):
    if len(counts) >= SHARDS and all(v >= PER_SHARD for v in counts.values()):
        break
    login = "demo%02d" % n
    s = Session()
    st, out = s.call("POST", "/api/register", {"login": login, "password": PW})
    if st != 200:
        st, out = s.call("POST", "/api/login", {"login": login, "password": PW})
    shard = out.get("assigned", "") if st == 200 else ""
    if not shard.startswith("shard-"):
        print("  %s: no shard (%s %s)" % (login, st, out)); continue
    st, cur = s.call("GET", "/api/students")
    have = cur.get("students", []) if st == 200 else []
    if not have:
        for _ in range(PER_ACCOUNT):
            serial += 1
            p = profile()
            s.call("POST", "/api/students", {"name": "%s %s" % (rnd.choice(FIRST), rnd.choice(LAST)),
                                             "regno": "RA2311027%06d" % (n * 100 + serial % 100), **p})
        have = s.call("GET", "/api/students")[1].get("students", [])
    else:
        for r in have:  # fill the new fields on records created before they existed
            if "gender" not in r:
                p = profile(); p.pop("marks"); p.pop("attendance")
                s.call("PUT", "/api/students/" + r["id"], p)
    counts[shard] = counts.get(shard, 0) + len(have)
    print("  %s -> %s (%d records)   totals: %s" % (login, shard, len(have), ", ".join("%s=%d" % kv for kv in sorted(counts.items()))))

print("\nRecords per shard:")
for k, v in sorted(counts.items()):
    print("  %s: %d" % (k, v))
