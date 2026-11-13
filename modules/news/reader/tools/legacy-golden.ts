// Writes the golden cases the Rust reader is checked against, by running the old TypeScript
// reader on them. Run from a checkout that has node_modules installed:
//   LEGACY_ROOT=/path/to/checkout pnpm exec tsx modules/news/reader/tools/legacy-golden.ts
// Output: tests/golden/legacy-cases.json and tests/fixtures/*.xml (bylines removed).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "tests");
const root = process.env["LEGACY_ROOT"] ?? join(here, "../../../..");
const load = async (rel: string) => import(join(root, "packages", rel));

const rss = await load("news/src/source/rss-source.ts");
const san = await load("news/src/source/sanitize.ts");
const red = await load("news/src/source/reddit-reader.ts");
const cat = await load("news/src/source/catalog.ts");
const tldts = await import(
  join(root, "node_modules/.pnpm/tldts@7.4.9/node_modules/tldts/dist/cjs/index.js")
);

mkdirSync(join(out, "fixtures"), { recursive: true });
mkdirSync(join(out, "golden"), { recursive: true });

// ---- fixtures: public feed captures with the author bylines removed ----
const originals = join(root, "packages/news/src/source/__fixtures__");
const sources: Array<[string, string]> = [
  ["bbc-feed.xml", "bbc"],
  ["guardian-feed.xml", "guardian"],
  ["npr-feed.xml", "npr"],
  ["verge-feed.xml", "verge"]
];
const feeds = [];
for (const [file, key] of sources) {
  const original = readFileSync(join(originals, file), "utf8");
  const stripped = original
    .replace(/<dc:creator>[\s\S]*?<\/dc:creator>/g, "")
    .replace(/<author>[\s\S]*?<\/author>/g, "");
  const hosts: string[] = cat.sourceEntry(key).imageHosts;
  const a = JSON.stringify(rss.toFeedItems(original, cat.sourceEntry(key)));
  const b = JSON.stringify(rss.toFeedItems(stripped, cat.sourceEntry(key)));
  if (a !== b) throw new Error(`byline removal changed the parse of ${file}`);
  writeFileSync(join(out, "fixtures", file), stripped);
  feeds.push({ fixture: file, imageHosts: hosts, items: JSON.parse(b) });
}

// ---- synthetic feeds (the old unit test's edge cases, plus more) ----
const wrap = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Synthetic</title>
${items}
  </channel>
</rss>`;
const item = (title: string, link: string, extra = "") =>
  `    <item>\n      <title>${title}</title>\n      <link>${link}</link>\n      ${extra}\n    </item>`;
const NPR = ["npr.brightspotcdn.com", "media.npr.org"];
const BBC = ["ichef.bbci.co.uk"];
const body = (html: string) =>
  `<content:encoded><![CDATA[\n        ${html}\n      ]]></content:encoded>`;
const synthetic: Array<{ name: string; xml: string; imageHosts: string[] }> = [];
const add = (name: string, xml: string, imageHosts: string[] = NPR) =>
  synthetic.push({ name, xml, imageHosts });

const img = (src: string, rest = ' width="800" height="450"') => `<img src="${src}"${rest}>`;
const real = "https://npr.brightspotcdn.com/real.jpg";
add(
  "tracking pixel then real",
  wrap(
    item(
      "T",
      "https://example.com/pixel",
      body(
        `${img("https://npr.brightspotcdn.com/track.gif", ' width="1" height="1"')}<p>x</p>${img(real)}`
      )
    )
  )
);
add(
  "only tracking pixel",
  wrap(
    item(
      "T",
      "https://example.com/only",
      body(img("https://npr.brightspotcdn.com/track.gif", ' width="1" height="1"'))
    )
  )
);
for (const [label, media] of [
  ["empty address", '<media:content url="" medium="image"/>'],
  ["no address", '<media:thumbnail width="240"/>'],
  ["enclosure no address", '<enclosure type="image/jpeg"/>']
] as const) {
  add(
    `media with ${label}`,
    wrap(item("U", "https://example.com/u", `${media}\n${body(img(real))}`))
  );
}
add(
  "lazy attribute after src",
  wrap(
    item(
      "L",
      "https://example.com/lazy",
      body(`<img src="${real}" data-src="https://unlisted.example/p.gif">`)
    )
  )
);
add(
  "gt in earlier attribute",
  wrap(
    item(
      "G",
      "https://example.com/gt",
      body(`<img alt="9 > 5" src="${real}" width="800" height="450">`)
    )
  )
);
add(
  "apostrophe entity",
  wrap(
    item("A", "https://example.com/a", body(img("https://npr.brightspotcdn.com/o&#39;brien.jpg")))
  )
);
add(
  "double escaped",
  wrap(
    item(
      "D",
      "https://example.com/d",
      body(img("https://npr.brightspotcdn.com/real.jpg?q=&amp;lt;x"))
    )
  )
);
add(
  "rejected media host",
  wrap(
    item(
      "R",
      "https://example.com/r",
      `<media:thumbnail url="https://unlisted.example/thumb.jpg" width="240"/>\n${body(img(real))}`
    )
  )
);
add(
  "unquoted one pixel",
  wrap(
    item(
      "Q",
      "https://example.com/q",
      body(`<img src="https://npr.brightspotcdn.com/t.gif" width=1 height=1>${img(real)}`)
    )
  )
);
add(
  "zero sized",
  wrap(
    item(
      "Z",
      "https://example.com/z",
      body(`<img src="https://npr.brightspotcdn.com/z.gif" width="0" height="0">${img(real)}`)
    )
  )
);
add(
  "counting host",
  wrap(
    item(
      "H",
      "https://example.com/h",
      body(`<img src="https://pixel.example.com/p.gif">${img(real)}`)
    )
  )
);
add(
  "impression query",
  wrap(
    item(
      "I",
      "https://example.com/i",
      body(`<img src="https://npr.brightspotcdn.com/i.gif?impression=abc123">${img(real)}`)
    )
  )
);
add(
  "uppercase tag",
  wrap(item("C", "https://example.com/c", body(`<IMG SRC="${real}" WIDTH="800" HEIGHT="450">`)))
);
add(
  "unquoted src",
  wrap(item("U", "https://example.com/uq", body(`<img src=${real} width=800 height=450>`)))
);
add(
  "multiline single quoted",
  wrap(
    item(
      "M",
      "https://example.com/m",
      body(
        `<img\n width=1\n height=1\n src='https://npr.brightspotcdn.com/s.gif'>\n<img\n width='800'\n alt='A real picture'\n src='${real}'\n height='450'>`
      )
    )
  )
);
for (const [label, name] of [
  ["cache buster", "real.jpg?cb=1720000000"],
  ["campaign source", "real.jpg?utm_source=newsletter"],
  ["handset", "google-pixel-10.jpg"],
  ["track.jpg", "track.jpg"],
  ["beacon.jpg", "beacon.jpg"],
  ["trk", "real.jpg?trk=newsletter"],
  ["tracking value", "real.jpg?tracking=newsletter"],
  ["pixel.gif", "pixel.gif"],
  ["pixel.jpeg2", "pixel.jpeg2"],
  ["impression dir", "impression/abc"],
  ["pixel key", "a.jpg?pixel=1"],
  ["Pixel key upper", "a.jpg?PIXEL"]
] as const) {
  add(
    `file ${label}`,
    wrap(
      item(
        "F",
        `https://example.com/${name.replace(/\W/g, "")}`,
        body(`${img("https://npr.brightspotcdn.com/" + name)}${img(real)}`)
      )
    )
  );
}
for (const [label, style] of [
  ["display none", "display:none"],
  ["spaced", "display : none ; margin: 0"],
  ["visibility", "visibility:hidden !important"],
  ["width one", "border:0; width: 1px !important;"],
  ["comment", "/* tracker */ display:/**/none"],
  ["height 0.0", "height: 0.00px"],
  ["visible", "display:block"],
  ["width 10", "width:10px"],
  ["width 1.5", "width:1.5px"]
] as const) {
  add(
    `style ${label}`,
    wrap(
      item(
        "S",
        `https://example.com/s${label.length}${label.charCodeAt(0)}`,
        body(`<img src="https://npr.brightspotcdn.com/h.gif" style="${style}">${img(real)}`)
      )
    )
  );
}
for (const [label, attrs] of [
  ["hidden", " hidden"],
  ["width auto", ' width="auto"'],
  ["width pct", ' width="50%"'],
  ["width 1px", ' width="1px"'],
  ["height 1.0", ' height="1.0"'],
  ["width 2", ' width="2"']
] as const) {
  add(
    `attr ${label}`,
    wrap(
      item(
        "W",
        `https://example.com/w${label.length}${label.charCodeAt(0)}`,
        body(`<img src="https://npr.brightspotcdn.com/h.gif"${attrs}>${img(real)}`)
      )
    )
  );
}
add(
  "relative and protocol relative",
  wrap(
    item(
      "P",
      "https://example.com/p",
      body(
        `<img src="//pixel.example.com/x.gif"><img src="/img/pixel.gif"><img src="/ok/photo.jpg"><img src="${real}">`
      )
    )
  ),
  [...NPR, "feed.invalid"]
);
add(
  "body in summary",
  wrap(
    item(
      "B",
      "https://example.com/b",
      `<description><![CDATA[<img src="${real}">hello]]></description>`
    )
  )
);
add(
  "entity-decoded summary html",
  wrap(
    item(
      "B",
      "https://example.com/b2",
      `<description>&lt;p&gt;Escaped &amp;amp; &lt;b&gt;bold&lt;/b&gt;&lt;/p&gt;</description>`
    )
  )
);
add(
  "big unterminated",
  wrap(
    item(
      "Malformed",
      "https://example.com/malformed",
      `<description>short</description>${body('<img data-role="hero" alt="unterminated '.repeat(7500))}`
    )
  )
);
add(
  "cap 30",
  wrap(
    Array.from({ length: 35 }, (_, i) => item(`Story ${i}`, `https://example.com/story-${i}`)).join(
      "\n"
    )
  ),
  BBC
);
add(
  "dedupe",
  wrap(
    item("First copy", "https://example.com/dup") +
      "\n" +
      item("Second copy", "https://example.com/dup")
  ),
  BBC
);
add(
  "javascript link",
  wrap(item("Evil", "javascript:alert(1)") + item("Fine", "https://example.com/ok")),
  BBC
);
add("empty title", wrap(item("&lt;b&gt;&lt;/b&gt;", "https://example.com/no-title")), BBC);
add(
  "off host art",
  wrap(
    item(
      "Off",
      "https://example.com/art",
      '<media:thumbnail url="https://evil.example/track.png" width="240"/>'
    )
  ),
  BBC
);
add(
  "http art",
  wrap(
    item(
      "Insecure",
      "https://example.com/art2",
      '<media:thumbnail url="http://ichef.bbci.co.uk/img.png" width="240"/>'
    )
  ),
  BBC
);
add(
  "podcast enclosure",
  wrap(
    item(
      "Pod",
      "https://example.com/pod",
      '<enclosure url="https://ichef.bbci.co.uk/audio.mp3" type="audio/mpeg" length="1"/>'
    )
  ),
  BBC
);
add(
  "enclosure image",
  wrap(
    item(
      "Enc",
      "https://example.com/enc",
      '<enclosure url="https://ichef.bbci.co.uk/a.jpg" type="image/jpeg" length="1"/>'
    )
  ),
  BBC
);
add(
  "media widths",
  wrap(
    item(
      "W",
      "https://example.com/w",
      '<media:content url="https://ichef.bbci.co.uk/140.jpg" width="140"/><media:content url="https://ichef.bbci.co.uk/700.jpg" width="700"/><media:content url="https://ichef.bbci.co.uk/460.jpg" width="460"/><media:thumbnail url="https://ichef.bbci.co.uk/t.jpg" width="9"/>'
    )
  ),
  BBC
);
add(
  "thumbnail then content",
  wrap(
    item(
      "W",
      "https://example.com/w3",
      '<media:thumbnail url="https://ichef.bbci.co.uk/t.jpg" width="900"/><media:content url="https://ichef.bbci.co.uk/c.jpg" width="10"/>'
    )
  ),
  BBC
);
add(
  "nested media in group",
  wrap(
    item(
      "G",
      "https://example.com/g",
      '<media:group><media:title>Inner</media:title><media:content url="https://ichef.bbci.co.uk/g.jpg" width="300"/></media:group>'
    )
  ),
  BBC
);
add(
  "rss dates",
  wrap(
    [
      "Thu, 09 Jul 2026 05:04:17 GMT",
      "Thu, 09 Jul 2026 05:04:17 +0100",
      "Thu, 09 Jul 2026 05:04 GMT",
      "9 Jul 2026 05:04:17 GMT",
      "2026-07-09T05:04:17Z",
      "2026-07-09T05:04:17.123+02:00",
      "2026-07-09",
      "nonsense",
      "",
      "Thu, 09 Jul 2026 05:04:17 EST"
    ]
      .map((d, i) => item(`D${i}`, `https://example.com/date${i}`, `<pubDate>${d}</pubDate>`))
      .join("\n")
  ),
  BBC
);
add(
  "atom entries",
  `<?xml version="1.0"?>\n<feed xmlns="http://www.w3.org/2005/Atom"\n      xmlns:media="http://search.yahoo.com/mrss/">\n<title>T</title><link href="https://example.com/"/>\n<entry><title type="html">Atom &amp; one</title><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/one?a=1&amp;b=2"/><published>2026-07-08T22:37:25-04:00</published><updated>2026-07-09T00:00:00Z</updated><summary>S &lt;i&gt;one&lt;/i&gt;</summary></entry>\n<entry><title>Atom two</title><link href="https://example.com/two"/><updated>2026-07-09T00:00:00Z</updated><content type="html">&lt;p&gt;Body &amp;#8217; two&lt;/p&gt;</content></entry>\n<entry><title>No link</title></entry>\n</feed>`,
  BBC
);
add(
  "cdata and entities",
  wrap(
    item(
      "<![CDATA[Tom &amp; Jerry &#8212; &hellip; &nbsp;done]]>",
      "https://example.com/cd",
      "<description><![CDATA[<p>Hello &amp; <b>world</b> &#x1F600; &#0000039;s &bogus; &#99999999; &#xD800;</p>]]></description>"
    )
  ) +
    item(
      "Plain &amp; &lt;b&gt;x&lt;/b&gt; &rsquo;q&rsquo; &#8217; &apos;",
      "https://example.com/cd2"
    ),
  BBC
);
add(
  "long title and summary",
  wrap(
    item(
      "word ".repeat(120),
      "https://example.com/long",
      `<description>${"sentence here ".repeat(100)}</description>`
    )
  ),
  BBC
);
add(
  "unicode",
  wrap(
    item(
      "Café ünïcödé 日本語 😀 title",
      "https://example.com/é?q=日本&x=a b",
      `<description>${"😀 ".repeat(300)}</description>`
    )
  ),
  BBC
);
add(
  "link whitespace",
  wrap(item("Spaces", "  https://Example.COM:443/Path/./a/../b?x=1#Frag  ")),
  BBC
);
add(
  "nested item",
  wrap(
    `    <item><title>Outer</title><link>https://example.com/outer</link><item><title>Inner</title><link>https://example.com/inner</link></item></item>`
  ),
  BBC
);
add(
  "self closing and empty tags",
  wrap(
    `    <item><title>Closed</title><link>https://example.com/closed</link><description/><media:thumbnail url="https://ichef.bbci.co.uk/x.jpg"/></item>`
  ),
  BBC
);
add(
  "truncated mid item",
  wrap(item("Kept", "https://example.com/kept") + "\n<item><title>Cut off"),
  BBC
);
add("not a feed", "<html><body>hi</body></html>", BBC);

const syntheticOut = synthetic.map((c) => ({
  name: c.name,
  imageHosts: c.imageHosts,
  xml: c.xml,
  items: rss.toFeedItems(c.xml, { imageHosts: c.imageHosts }),
  public: rss.parsePublicFeedItems(c.xml),
  isFeed: rss.isPublicFeedDocument(c.xml)
}));

// ---- feed document validation ----
const docs = [
  `<rss version="2.0"><channel><title>x</title></channel></rss>`,
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
  `<feed/>`,
  `<rss><channel/></rss>`,
  `<rss></rss>`,
  `<rss><channel></rss>`,
  `<feed></rss>`,
  `<feed><entry></feed>`,
  `text before <feed></feed>`,
  `<feed></feed> trailing`,
  `<feed></feed><feed></feed>`,
  String.fromCharCode(0xfeff) + `<feed></feed>`,
  `  \n<feed></feed>\n  `,
  `<FEED></FEED>`,
  `<Feed></feed>`,
  `<html><body>blocked</body></html>`,
  ``,
  `{"kind":"Listing"}`,
  `<feed><!-- c --><title>T &amp; U</title></feed>`,
  `<feed><![CDATA[ x ]]></feed>`,
  `<feed><a b="1" b="2"/></feed>`,
  `<rss version="2.0"><channel><item/></channel></rss>`,
  `<feed>AT&T</feed>`,
  `<feed></feed></x>`,
  `<feed><a></b></a></feed>`,
  `<feed><a><b></a></feed>`,
  `<FEED></FEED>`,
  `<feed><a/></feed>`
];
const docsOut = docs.map((xml) => ({ xml, isFeed: rss.isPublicFeedDocument(xml) }));

// ---- sanitizers ----
const textInputs: Array<[string | null, number]> = [
  [null, 10],
  ["", 10],
  ["plain text", 300],
  ["<b>bold</b> and <i>it</i>", 300],
  ["a < b > c", 300],
  ["<<b>x", 300],
  ["<>x>", 300],
  ["x < y", 300],
  ["unterminated <tag attr", 300],
  ["&lt;p&gt;escaped&lt;/p&gt;", 300],
  ["&amp;lt;p&amp;gt;double", 300],
  [
    "Tom &amp; Jerry &quot;q&quot; &#39;s &#039;t &#0039;u &apos;v &rsquo;w &lsquo;x &ldquo;y&rdquo; &mdash; &ndash; &hellip; &nbsp;z",
    300
  ],
  ["&#65;&#x42;&#x1F600;&#0;&#1114112;&#55357;&#xD800;&#;&#x;&#12", 300],
  ["&#99999999999999999999;", 300],
  ["&amp;#39;", 300],
  ["  lots   of \n\t space    here  ", 300],
  ["﻿bom text﻿", 300],
  ["line sep\u0085nel", 300],
  ["word ".repeat(120), 300],
  ["word ".repeat(120), 50],
  ["x".repeat(400), 300],
  ["😀".repeat(200), 300],
  ["a😀".repeat(200), 301],
  ["short words ".repeat(40) + "averyveryverylongwordwithoutspaces".repeat(5), 500],
  ["tab\tsep", 300],
  ["é ".repeat(200), 300]
];
const textOut = textInputs.map(([raw, cap]) => ({ raw, cap, out: san.sanitizeFeedText(raw, cap) }));

const urlInputs = [
  "https://example.com/story",
  "http://example.com",
  "https://Example.COM:443/Path/./a/../b?x=1#Frag",
  "HTTP://EXAMPLE.com:80/",
  "https://example.com:8080/a b",
  "https://user:pass@example.com/",
  "https://user@example.com",
  "javascript:alert(1)",
  "ftp://example.com/f",
  "//example.com/x",
  "/relative",
  "example.com",
  "",
  "   https://example.com/trim  ",
  "https://example.com/é?q=日本&x=a b#frag ment",
  "https://münchen.example/ü",
  "https://EXAMPLE.com./a",
  "https://exa mple.com/",
  "https://example.com:99999/",
  "https://example.com:abc/",
  "https://example.com:/x",
  "https://127.0.0.1/a",
  "https://0x7f.1/a",
  "https://[::1]/a",
  "https://[2001:DB8::1]:8443/a",
  "https://example.com/a?b=c&d=e#",
  "https://example.com/?",
  "https://example.com/a/../../b",
  "https://example.com/a/%2e%2e/b",
  "https://example.com/%7Efoo/%zz",
  "https:example.com/a",
  "https:\\\\example.com\\a\\b",
  "http://a.com/path?x='y'",
  "https://example.com/a'b\"c<d>e`f{g}h",
  "https://example.com/?q=a'b\"c<d>e`f",
  "https://example.com/#a'b\"c<d>e`f",
  "https://a_b.example.com/",
  "https://example.com/ x",
  "https://exämple.com",
  "https://xn--mnchen-3ya.example/",
  "https://example.com/a\tb\nc",
  "https://1.2.3.4.5/",
  "https://256.1.1.1/",
  "https://1.1.1/",
  "https://example.com/%E3%81%82",
  "https://EXAMPLE.COM:8443",
  "https://example.com/a#b#c",
  "https://example.com//double//slash",
  "https://example.com/a?b?c",
  "mailto:a@b.c",
  "https://",
  "https:///x",
  "https://.example.com/",
  "https://example..com/"
];
const urlsOut = urlInputs.map((raw) => ({ raw, out: san.sanitizeItemUrl(raw) }));
const imageInputs: Array<[string | null, string[]]> = [
  ["https://ichef.bbci.co.uk/a.jpg", ["ichef.bbci.co.uk"]],
  ["http://ichef.bbci.co.uk/a.jpg", ["ichef.bbci.co.uk"]],
  ["https://ICHEF.bbci.co.uk/a.jpg", ["ichef.bbci.co.uk"]],
  ["https://other.example/a.jpg", ["ichef.bbci.co.uk"]],
  [null, ["x"]],
  ["", ["x"]],
  ["  https://ichef.bbci.co.uk/a.jpg  ", ["ichef.bbci.co.uk"]],
  ["https://ichef.bbci.co.uk:8443/a.jpg", ["ichef.bbci.co.uk"]]
];
const imagesOut = imageInputs.map(([raw, hosts]) => ({
  raw,
  hosts,
  out: san.sanitizeImageUrl(raw, hosts)
}));
const dates = [
  null,
  "",
  "Thu, 09 Jul 2026 05:04:17 GMT",
  "Thu, 09 Jul 2026 05:04:17 +0100",
  "Thu, 09 Jul 2026 05:04:17 -0500",
  "Thu, 9 Jul 2026 05:04:17 GMT",
  "9 Jul 2026 05:04:17 GMT",
  "2026-07-09T05:04:17Z",
  "2026-07-09T05:04:17.5Z",
  "2026-07-09T05:04:17.123456Z",
  "2026-07-09T05:04:17+02:00",
  "2026-07-09",
  "  2026-07-09T05:04:17Z  ",
  "garbage",
  "2026-13-40T00:00:00Z",
  "Thu, 09 Jul 2026 05:04:17 UT",
  "Thu, 09 Jul 2026 05:04:17 PST",
  "1970-01-01T00:00:00Z",
  "0001-01-01T00:00:00Z"
];
const datesOut = dates.map((raw) => ({ raw, out: san.sanitizePublishedAt(raw) }));
const ids = [
  "https://example.com/story",
  "",
  "https://example.com/é",
  "a",
  "https://www.bbc.co.uk/news/articles/cdx78n4nkvyo?at_medium=RSS&at_campaign=rss"
];
const idsOut = ids.map((raw) => ({ raw, out: rss.stableIdForUrl(raw) }));

// ---- publisher identity ----
const hosts = [
  "www.bbc.co.uk",
  "news.bbc.co.uk",
  "bbc.co.uk",
  "co.uk",
  "uk",
  "www.theguardian.com",
  "foo.github.io",
  "github.io",
  "a.b.blogspot.com",
  "blogspot.com",
  "localhost",
  "intranet",
  "example.invalid",
  "www.example.invalid",
  "1.2.3.4",
  "[::1]",
  "WWW.ESPN.COM",
  "espn.com.",
  "",
  "xn--mnchen-3ya.de",
  "www.münchen.de",
  "x.kobe.jp",
  "city.kobe.jp",
  "foo.ck",
  "www.ck",
  "something.compute.amazonaws.com",
  "user.s3.amazonaws.com",
  "a.example.co.jp",
  "www.nytimes.com",
  "reddit.com",
  "old.reddit.com",
  "com",
  "foo.com.au",
  "foo.bar.com.au"
];
const identOut = hosts.map((h) => ({
  host: h,
  identity: tldts.getDomain(h, { allowPrivateDomains: true })
}));

// ---- reddit ----
const FEED_URL_UPPER = "https://www.reddit.com/r/NFL/hot.rss";
const entry = (
  o: {
    id?: string;
    title?: string;
    link?: string | null;
    published?: string | null;
    content?: string;
  } = {}
) => {
  const id = o.id ?? "t3_abc123";
  const title = o.title ?? "Chiefs sign a new kicker";
  const link =
    o.link === undefined ? "https://www.espn.com/nfl/story/_/id/1/chiefs-sign-kicker" : o.link;
  const thread = `https://www.reddit.com/r/nfl/comments/${id.slice(3)}/thread/`;
  const html =
    o.content ??
    `<!-- SC_OFF --><div class="md"><p>Body</p></div><!-- SC_ON --> submitted by <a href="https://www.reddit.com/user/fan"> /u/fan </a> <br/>` +
      (link === null ? "" : ` <span><a href="${link}">[link]</a></span>`) +
      ` <span><a href="${thread}">[comments]</a></span>`;
  const escaped = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const published = o.published === undefined ? "2025-09-04T14:13:20+00:00" : o.published;
  return (
    `<entry><author><name>/u/fan</name></author><category term="nfl" label="r/nfl"/><content type="html">${escaped}</content><id>${id}</id><link href="${thread}" />` +
    (published ? `<updated>${published}</updated><published>${published}</published>` : "") +
    `<title>${title}</title></entry>`
  );
};
const feed = (entries: string[], head?: { term?: string; title?: string }) =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><category term="${head?.term ?? "nfl"}" label="r/${head?.term ?? "nfl"}"/><updated>2025-09-04T14:13:20+00:00</updated><icon>https://www.redditstatic.com/icon.png/</icon><id>/r/nfl/hot.rss</id><link rel="self" href="https://www.reddit.com/r/nfl/hot.rss" type="application/atom+xml" /><link rel="alternate" href="https://www.reddit.com/r/nfl/new" type="text/html" /><subtitle>The place for NFL news.</subtitle><title>${head?.title ?? "NFL: National Football League Discussion"}</title>` +
  entries.join("") +
  `</feed>`;

const inputs = [
  "r/nfl",
  "/r/nfl",
  "R/NFL/",
  "https://www.reddit.com/r/LiverpoolFC",
  "https://old.reddit.com/r/CollegeBasketball/new/",
  "reddit.com/r/nfl?sort=new",
  "https://www.reddit.com/r/nfl/comments/abc/some_post/",
  "r/ab",
  "r/this_name_is_far_too_long_for_reddit",
  "r/bad-name",
  "r/b.d",
  "theathletic.com",
  "https://one.example/feed.xml",
  "https://www.reddit.com/user/someone",
  "r",
  "r/",
  "  r/nfl  ",
  "HTTPS://WWW.REDDIT.COM/R/Nfl.RSS",
  "https://www.reddit.com/r/nfl.rss?x=1",
  "https://www.reddit.com/r/nfl.rss.foo",
  "https://www.reddit.com/r/nfl.json",
  "http://reddit.com/r/nfl#top",
  "reddit.com/r/nfl/\nx",
  "https://www.reddit.com/r/",
  "https://m.reddit.com/r/nfl",
  "r/nfl/",
  "//r/nfl",
  "r/nfl?x",
  "r/éé_",
  "/r/N_F_L_9/",
  "https://www.reddit.com/r/nfl.rss/extra"
];
const inputsOut = inputs.map((raw) => ({ raw, out: red.parseSubredditInput(raw) }));
const nameUrls = [
  FEED_URL_UPPER,
  "https://espn.com/nfl",
  null,
  "https://www.reddit.com/r/nfl/",
  "r/ab"
];
const nameUrlsOut = nameUrls.map((raw) => ({ raw, out: red.subredditNameFromUrl(raw) }));
const urlHelpers = ["NFL", "nfl", "LiverpoolFC"].map((name) => ({
  name,
  home: red.redditSubredditUrl(name),
  hot: red.redditHotFeedUrl(name)
}));

const link = (l: string | null, extra: Record<string, unknown> = {}) => ({ link: l, ...extra });
const entryCases: Array<{ name: string; xml: string; publisherDomain?: string | null }> = [];
const addEntry = (name: string, xml: string, publisherDomain?: string | null) =>
  entryCases.push({ name, xml, publisherDomain });
addEntry("plain article", entry());
addEntry("caller domain rule", entry(link("https://news.bbc.co.uk/sport/1")), "bbc.co.uk");
addEntry("caller domain internal", entry(link("https://news.bbc.co.uk/sport/1")), "reddit.com");
addEntry("caller domain www", entry(link("https://news.bbc.co.uk/sport/1")), "www.bbc.co.uk");
addEntry(
  "entities in link",
  entry(link("https://news.example/story?a=1&b=2", { published: null }))
);
for (const [label, l] of [
  ["self post", "https://www.reddit.com/r/nfl/comments/abc123/x/"],
  ["no link anchor", null],
  ["image", "https://i.redd.it/abc.png"],
  ["video", "https://v.redd.it/abc"],
  ["internal", "https://www.reddit.com/r/other/comments/xyz/"],
  ["short", "https://redd.it/xyz"],
  ["preview", "https://preview.redd.it/abc.jpg"],
  ["ftp", "ftp://files.example/report"],
  ["credentials", "https://user:pw@news.example/a"],
  ["trailing dot host", "https://News.Example./a"],
  ["www", "https://www.news.example/a"],
  ["port", "https://news.example:8443/a"],
  ["relative", "/relative"]
] as const) {
  addEntry(label, entry(link(l)));
}
addEntry("no title", entry({ title: "" }));
addEntry("html title", entry({ title: "<b>Bold</b> &amp; &lt;i&gt;x&lt;/i&gt; title" }));
addEntry("cdata title", entry({ title: "<![CDATA[Cdata &amp; title]]>" }));
addEntry("no id", entry({ id: "" }).replace("<id></id>", ""));
addEntry("blank id", entry({ id: "   " }));
addEntry("updated only", entry().replace(/<published>[^<]*<\/published>/, ""));
addEntry(
  "empty published",
  entry().replace(/<published>[^<]*<\/published>/, "<published></published>")
);
addEntry("bad date", entry({ published: "yesterday" }));
addEntry(
  "summary instead of content",
  entry()
    .replace(/<content /, "<summary ")
    .replace("</content>", "</summary>")
);
addEntry("uppercase tags", entry().toUpperCase().replace("HTTPS://", "https://"));
addEntry(
  "link anchor uppercase",
  entry({ content: `<a HREF="https://news.example/up">[LINK]</a>` })
);
addEntry(
  "link anchor spaced",
  entry({
    content: `<a  class="x"   href="https://news.example/sp" target="_blank">  [link]  </a>`
  })
);
addEntry(
  "two anchors",
  entry({
    content: `<a href="https://news.example/first">[comments]</a> <a href="https://news.example/second">[link]</a>`
  })
);
addEntry(
  "anchor with gt in href",
  entry({ content: `<a href="https://news.example/a>b">[link]</a>` })
);
addEntry(
  "numeric entity link",
  entry({ content: `<a href="https://news.example/a&#38;b&#x26;c&amp;d">[link]</a>` })
);
addEntry("entity title numeric first", entry({ title: "A &#38;lt;b&#38;gt; B" }));
const entryOut = entryCases.map((c) => ({
  name: c.name,
  xml: c.xml,
  publisherDomain: c.publisherDomain ?? null,
  out: red.redditEntryToHeadline(
    c.xml,
    c.publisherDomain === undefined || c.publisherDomain === null
      ? {}
      : { publisherDomain: () => c.publisherDomain }
  )
}));

const manyEntries = Array.from({ length: 60 }, (_, i) =>
  entry({ id: `t3_p${i}`, link: `https://news.example/story/${i % 50}` })
);
const feedCases: Array<{ name: string; body: string; fallback: string; limit?: number }> = [
  { name: "forty cap and dedupe", body: feed(manyEntries), fallback: "nfl" },
  { name: "limit ten", body: feed(manyEntries), fallback: "nfl", limit: 10 },
  { name: "limit zero", body: feed(manyEntries), fallback: "nfl", limit: 0 },
  { name: "repeat entries", body: feed([entry(), entry()]), fallback: "nfl" },
  {
    name: "casing from head",
    body: feed([], { term: "LiverpoolFC", title: "Liverpool FC" }),
    fallback: "liverpoolfc"
  },
  { name: "no category", body: feed([]).replace(/<category[^>]*\/>/, ""), fallback: "nfl" },
  { name: "bad term", body: feed([], { term: "x" }), fallback: "nfl" },
  { name: "json", body: '{"kind":"Listing"}', fallback: "nfl" },
  { name: "html", body: "<html><body>blocked</body></html>", fallback: "nfl" },
  {
    name: "rss channel",
    body: '<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>',
    fallback: "nfl"
  },
  {
    name: "mixed entries",
    body: feed([
      entry(link("https://i.redd.it/a.png")),
      entry({ id: "t3_b", link: "https://news.example/b" }),
      entry({ id: "t3_c", link: null })
    ]),
    fallback: "nfl"
  },
  {
    name: "entry tag boundary",
    body: feed([entry()])
      .replace("<entry>", "<entry >")
      .replace("</title></entry>", "</title></entry><entryx>junk</entryx>"),
    fallback: "nfl"
  },
  {
    name: "title entities",
    body: feed([], { title: "NFL &amp; <![CDATA[more]]> &#8212; x" }),
    fallback: "nfl"
  },
  {
    name: "empty feed",
    body: `<feed xmlns="http://www.w3.org/2005/Atom"></feed>`,
    fallback: "fallback"
  }
];
const feedOut = feedCases.map((c) => ({
  ...c,
  limit: c.limit ?? null,
  out: red.parseRedditFeed(c.body, c.fallback, c.limit === undefined ? {} : { limit: c.limit })
}));

const failures: Array<{ reason: string; status?: number; detail?: string }> = [
  { reason: "http_error", status: 403 },
  { reason: "http_error", status: 401 },
  { reason: "http_error", status: 404 },
  { reason: "http_error", status: 429 },
  { reason: "rate_limited" },
  { reason: "http_error", status: 503 },
  { reason: "network" },
  { reason: "timeout" },
  { reason: "blocked" },
  { reason: "blocked", detail: "unsupported_content_type" },
  { reason: "blocked", status: 404 },
  { reason: "rate_limited", status: 403 }
];
const failOut = failures.map((f) => ({ ...f, out: red.redditFailureReason(f) }));

const hopUrls: Array<[string, number]> = [
  [FEED_URL_UPPER, 0],
  ["https://www.reddit.com/search?q=nfl", 1],
  ["https://old.reddit.com/r/NFL/hot.rss", 0],
  ["https://www.reddit.com:8443/r/NFL/hot.rss", 0],
  [FEED_URL_UPPER, 1],
  ["https://WWW.REDDIT.COM/r/NFL/hot.rss", 0],
  ["https://www.reddit.com/r/nfl/hot.rss", 0],
  ["https://www.reddit.com/r/NFL/hot.rss?x=1", 0],
  ["https://www.reddit.com:443/r/NFL/hot.rss", 0]
];
const guard = red.redditHopGuard(FEED_URL_UPPER);
const hopsOut = hopUrls.map(([u, n]) => ({
  url: u,
  redirectCount: n,
  out: guard({ url: new URL(u), redirectCount: n })
}));
const opts = red.redditFetchOptions(FEED_URL_UPPER);
const optionsOut = {
  allowedHosts: opts.allowedHosts,
  accept: opts.requestHeaders.accept,
  userAgent: opts.userAgent,
  allowedContentTypes: opts.allowedContentTypes,
  maxBytes: opts.maxBytes,
  rejectOversizedResponses: opts.rejectOversizedResponses,
  skipRobots: opts.skipRobots
};

const readCases: Array<{ name: string; requestName: string; result: Record<string, unknown> }> = [
  {
    name: "ok with casing",
    requestName: "NFL",
    result: {
      ok: true,
      status: 200,
      finalUrl: FEED_URL_UPPER,
      contentType: "application/atom+xml; charset=UTF-8",
      body: feed([entry()]),
      truncated: false
    }
  },
  { name: "404", requestName: "nfl", result: { ok: false, reason: "http_error", status: 404 } },
  {
    name: "html body",
    requestName: "nfl",
    result: {
      ok: true,
      status: 200,
      finalUrl: "x",
      contentType: "text/html",
      body: "<html>blocked</html>",
      truncated: false
    }
  },
  { name: "403", requestName: "nfl", result: { ok: false, reason: "http_error", status: 403 } },
  { name: "429", requestName: "nfl", result: { ok: false, reason: "http_error", status: 429 } },
  { name: "network", requestName: "nfl", result: { ok: false, reason: "network" } }
];
const readOut = [];
for (const c of readCases) {
  const calls: string[] = [];
  const r = await red.readSubreddit(async (url: string) => {
    calls.push(url);
    return c.result;
  }, c.requestName);
  readOut.push({ ...c, calls, out: r });
}

writeFileSync(
  join(out, "golden", "legacy-cases.json"),
  JSON.stringify(
    {
      note: "Generated by tools/legacy-golden.ts from the old TypeScript reader. Do not edit.",
      feeds,
      synthetic: syntheticOut,
      docs: docsOut,
      text: textOut,
      urls: urlsOut,
      images: imagesOut,
      dates: datesOut,
      ids: idsOut,
      identity: identOut,
      subredditInputs: inputsOut,
      nameUrls: nameUrlsOut,
      urlHelpers,
      entries: entryOut,
      redditFeeds: feedOut,
      failures: failOut,
      hops: hopsOut,
      fetchOptions: optionsOut,
      reads: readOut
    },
    null,
    1
  ) + "\n"
);
console.log("golden written");
