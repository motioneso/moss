// Synthetic feed cases for legacy-golden.ts: the old unit test edge cases plus more.
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

export { synthetic };
