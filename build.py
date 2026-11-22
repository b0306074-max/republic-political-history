"""Validate the curated register and build the static site's JSON."""
import calendar
import json
from collections import Counter
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
FIRST = "1949-10-01"
LAST = "1978-12-31"
DOMAINS = {"party": "中央党务", "state": "国家政务", "military": "军事领导"}
LEGACY_FILE = "共和国政治大明星_首批历史数据_v0.1.json"
PARTY_TIERS = {
    "中共中央主席": 1,
    "中共中央第一副主席": 2,
    "中共中央副主席": 3,
    "七届中央书记处书记": 4,
    "中央政治局常委": 4,
    "中央政治局委员": 5,
    "中央政治局候补委员": 6,
    "中央书记处书记": 7,
    "中央书记处候补书记": 8,
    "中央委员会委员": 8,
    "中央委员会候补委员": 9,
}


def boundary(value):
    if len(value) == 7:
        year, month = map(int, value.split("-"))
        return f"{value}-{calendar.monthrange(year, month)[1]:02d}"
    return date.fromisoformat(value).isoformat()


def sections():
    result = {}
    for line in (ROOT / "records.txt").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line.startswith("["):
            rows = result.setdefault(line[1:-1], [])
        elif line and not line.startswith("#"):
            rows.append([field.strip() for field in line.split("|")])
    return result


def source_keys(values, sources):
    keys = values.split()
    assert keys and all(key in sources for key in keys), values
    return keys


def load_register():
    register = sections()
    legacy = json.loads((ROOT / LEGACY_FILE).read_text(encoding="utf-8-sig"))
    added = register["people"][0][0].split()
    names = list(legacy["persons"]) + added
    assert len(names) == len(set(names)) == 50
    sources = {key: {"title": title, "url": url} for key, title, url in register["sources"]}
    assert all(urlparse(item["url"]).scheme == "https" for item in sources.values())
    people = {name: {"events": [], "roles": [], "legacy": []} for name in names}
    deaths = {}
    for name, records in legacy["persons"].items():
        for record in records:
            listed = record["date"]
            if record["level"] == "逝世":
                deaths[name] = listed
                continue
            # A first-of-month marker in the migration is treated conservatively.
            if listed.endswith("-01") and listed != FIRST:
                listed = listed[:7]
            people[name]["legacy"].append({
                "date": listed, "label": record["detail"], "category": record["level"],
            })

    for names_field, when, label, keys in register["events"]:
        for name in names_field.split():
            people[name]["events"].append({
                "date": when, "label": label, "sources": source_keys(keys, sources),
            })
            if label == "逝世。":
                deaths[name] = when

    for name, when in deaths.items():
        # Keep dates carried from the original separately labeled in the person record.
        if not any(event["label"] == "逝世。" for event in people[name]["events"]):
            people[name]["legacy"].append({"date": when, "label": "逝世。", "category": "逝世"})
        people[name]["death"] = when

    changes = {}
    for name, domain, when, fragments, mode, keys in register["adjustments"]:
        assert name in people and (domain == "*" or domain in DOMAINS)
        assert mode in {"remove", "uncertain"}
        changes.setdefault(name, []).append(
            (domain, when, fragments.split(), mode, source_keys(keys, sources))
        )

    for domain, title, tier, start, end, keys, names_field in register["roles"]:
        assert domain in DOMAINS and 0 < int(tier) < 10
        level = int(tier)
        if domain == "party":
            level = PARTY_TIERS[title] if title in PARTY_TIERS else PARTY_TIERS[title.split("届", 1)[1]]
        assert FIRST <= boundary(start) <= LAST
        assert not end or boundary(start) < boundary(end)
        for name in names_field.split():
            stop = end
            unclear = None
            citations = source_keys(keys, sources)
            for target, when, fragments, mode, references in changes.get(name, []):
                if target not in {"*", domain}:
                    continue
                if not any(fragment == "*" or fragment in title for fragment in fragments):
                    continue
                if not boundary(start) < boundary(when) < (boundary(stop) if stop else "1979-01-01"):
                    continue
                citations = list(dict.fromkeys(citations + references))
                if mode == "remove":
                    stop = when
                elif not unclear or boundary(when) < boundary(unclear):
                    unclear = when
            people[name]["roles"].append({
                "domain": domain, "title": title, "tier": level,
                "start": start, "end": stop, "uncertain": unclear, "sources": citations,
            })

    nodes = []
    for when, label, detail, keys in register["nodes"]:
        nodes.append({
            "date": when, "at": boundary(when), "label": label,
            "detail": detail, "sources": source_keys(keys, sources),
        })
    assert all(a["at"] < b["at"] for a, b in zip(nodes, nodes[1:]))
    matches = Counter(role["domain"] for person in people.values() for role in person["roles"])
    assert all(matches[domain] for domain in DOMAINS)
    assert all(len(person["roles"]) + len(person["events"]) >= 2 for person in people.values())
    return {"version": "0.2", "domains": DOMAINS, "people": people, "nodes": nodes, "sources": sources}


if __name__ == "__main__":
    data = load_register()
    (ROOT / "history-v02.json").write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    counts = Counter({
        "人物": len(data["people"]),
        "公共节点": len(data["nodes"]),
        "任职区间": sum(len(person["roles"]) for person in data["people"].values()),
        "有出处的补充事件": sum(len(person["events"]) for person in data["people"].values()),
        "来源": len(data["sources"]),
    })
    print(json.dumps(counts, ensure_ascii=True))
