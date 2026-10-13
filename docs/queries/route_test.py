"""Route test on RINF micro topology (era:LinearElement + era:NetRelation).

Inputs (CSV results of the queries in docs/queries):
  ne.csv     -> 04-netelements.rq        (e, len)
  rel.csv    -> 05-netrelations.rq       (r, a, b, oa, ob, nav)
  op_ne.csv  -> 06-op-to-netelements.rq  (op, uopid, name, ne, startOff, endOff)

Usage: python route_test.py DATA_DIR UOPID_FROM UOPID_TO [UOPID_FROM UOPID_TO ...]

Graph model: a state is (element, side) = "standing at that end of the element".
Traversing an element costs its length; a NetRelation with navigability Both
lets a train pass from (A, sideA) to (B, sideB) at zero cost. Relations with
navigability None (switch leg-to-leg) are ignored, so no U-turns at switches.
"""
import csv, heapq, sys, os
from collections import defaultdict

d = sys.argv[1]
def rows(f):
    with open(os.path.join(d, f), encoding="utf-8") as fh:
        yield from csv.DictReader(fh)

length = {r["e"]: float(r["len"]) for r in rows("ne.csv")}
links = defaultdict(list)   # (e, side) -> [(e2, side2)] ; side 0 = origin, 1 = end
deg = defaultdict(int)
nav_none = 0
for r in rows("rel.csv"):
    sa = 0 if r["oa"] == "true" else 1
    sb = 0 if r["ob"] == "true" else 1
    deg[r["a"]] += 1; deg[r["b"]] += 1
    if not r["nav"].endswith("Both"):
        nav_none += 1
        continue
    links[(r["a"], sa)].append((r["b"], sb))
    links[(r["b"], sb)].append((r["a"], sa))

op_ne = defaultdict(set); names = {}
span = {}   # (uopid, ne) -> (min offset, max offset) of the OP area on that element
for r in rows("op_ne.csv"):
    u, e = r["uopid"], r["ne"]
    op_ne[u].add(e); names[u] = r["name"]
    lo, hi = sorted((float(r["startOff"]), float(r["endOff"])))
    a, b = span.get((u, e), (lo, hi))
    span[(u, e)] = (min(a, lo), max(b, hi))

# connected components (undirected, Both relations only)
parent = {e: e for e in length}
def find(x):
    while parent[x] != x:
        parent[x] = parent[parent[x]]; x = parent[x]
    return x
for (e, _), lst in links.items():
    for e2, _ in lst:
        if e in parent and e2 in parent:
            parent[find(e)] = find(e2)
comp = defaultdict(int)
for e in length: comp[find(e)] += 1
sizes = sorted(comp.values(), reverse=True)
unknown = {e for (e, _), l in links.items() if e not in length} | {e2 for l in links.values() for e2, _ in l if e2 not in length}
isolated = sum(1 for e in length if deg[e] == 0)
total_len = sum(length.values())
largest_root = max(comp, key=comp.get)
largest_len = sum(l for e, l in length.items() if find(e) == largest_root)
print(f"micro elements: {len(length)}, total length {total_len/1000:.1f} km")
print(f"relations ignored (navigability None): {nav_none}")
print(f"relations pointing to unknown elements: {len(unknown)}")
print(f"elements without any relation: {isolated}")
print(f"components: {len(sizes)}; largest {sizes[0]} elements ({largest_len/1000:.1f} km, {100*largest_len/total_len:.1f}% of length); next: {sizes[1:8]}")
ops_in_largest = sum(1 for u, s in op_ne.items() if any(find(e) == largest_root for e in s if e in parent))
print(f"OPs with net reference: {len(op_ne)}; OPs touching largest component: {ops_in_largest}")

def route(u1, u2):
    src, dst = op_ne[u1], op_ne[u2]
    length.setdefault('__DST__', 0.0); last = [None]
    dist, prev, pq = {}, {}, []
    for e in src:
        if e not in length: continue
        lo, hi = span[(u1, e)]
        for side, c0 in ((0, lo), (1, length[e] - hi)):  # leave the OP area via either end
            c0 = max(c0, 0.0)
            if c0 < dist.get((e, side), 1e18):
                dist[(e, side)] = c0; prev[(e, side)] = None
                heapq.heappush(pq, (c0, e, side))
    while pq:
        c, e, side = heapq.heappop(pq)
        if c > dist.get((e, side), 1e18): continue
        if e == "__DST__":
            path = [last[0]]; s = prev[(e, side)]
            while s: path.append(s); s = prev[s]
            return c, path[::-1]
        for e2, s2 in links[(e, side)]:
            if e2 not in length: continue
            if e2 in dst:   # reaching the target OP area on e2
                lo, hi = span[(u2, e2)]
                tc = c + max(0.0, lo if s2 == 0 else length[e2] - hi)
                if tc < dist.get(("__DST__", 0), 1e18):
                    dist[("__DST__", 0)] = tc; prev[("__DST__", 0)] = (e, side); last[0] = (e2, 1 - s2)
                    heapq.heappush(pq, (tc, "__DST__", 0))
            nc = c + length[e2]; ns = (e2, 1 - s2)   # enter e2 at s2, leave at other end
            if nc < dist.get(ns, 1e18):
                dist[ns] = nc; prev[ns] = (e, side); heapq.heappush(pq, (nc, e2, 1 - s2))
    return None, None

args = sys.argv[2:]
for i in range(0, len(args), 2):
    a, b = args[i], args[i + 1]
    c, path = route(a, b)
    if c is None:
        print(f"{names.get(a,a)} -> {names.get(b,b)}: NO ROUTE"); continue
    print(f"{names.get(a,a)} ({a}) -> {names.get(b,b)} ({b}): {c/1000:.2f} km over {len(path)} elements")
    if os.environ.get("DUMP"):
        with open(os.path.join(d, f"route_{a}_{b}.txt"), "w", encoding="utf-8") as fh:
            for e, side in path: fh.write(f"{e},{side}\n")
