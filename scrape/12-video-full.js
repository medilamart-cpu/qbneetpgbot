/* 12-video-full.js — corrected full video index with real field names.
 *
 * /qbapi/videos items use:  t=title, k=key, s=status, n=nonce, d=date
 * (no duration/id/title as previously assumed). This produces the complete
 * per-course -> section -> video structure.
 *
 * HOW TO USE
 *   Signed in at qb.neetpgbot.in. F12 -> Console. Clear input, paste, Enter.
 *   Then:   copy(window.qbVideoFull.json())   -> video-full.json
 */
(async () => {
  const log = (...a) => console.log("%c[VID]", "color:#09f;font-weight:bold", ...a);
  const vr = await fetch("/qbapi/videos", { credentials: "include" });
  const vd = await vr.json();
  const courses = (vd.courses || []).map((c) => ({
    id: c.id,
    title: c.title,
    group: c.group,
    sections: (c.sections || []).map((s) => ({
      title: s.title,
      videos: (s.videos || s.lectures || s.items || s.episodes || s.lessons || []).map((v) => ({
        title: v.t,
        key: v.k,
        status: v.s,
        nonce: v.n,
        date: v.d
      }))
    }))
  }));

  const groups = {};
  for (const c of courses) {
    const g = c.group || "(none)";
    const s = groups[g] || (groups[g] = { courses: 0, sections: 0, videos: 0 });
    s.courses++; s.sections += c.sections.length;
    for (const sec of c.sections) s.videos += sec.videos.length;
  }
  console.log("%c=== VIDEO GROUPS ===", "color:#0f0;font-size:13px");
  console.table(groups);
  log("courses:", courses.length, "sections:", courses.reduce((a, c) => a + c.sections.length, 0),
      "videos:", courses.reduce((a, c) => a + c.sections.reduce((b, s) => b + s.videos.length, 0), 0));

  window.qbVideoFull = {
    courses, groups,
    json: () => JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: "/qbapi/videos",
      built: vd.built,
      liveBuilt: vd.live_built,
      courseCount: courses.length,
      groups,
      courses
    }, null, 2)
  };
  log("run:  copy(window.qbVideoFull.json())   -> video-full.json");
})();
