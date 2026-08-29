const assert = require('assert')
const scan = require('../vault-scan')

function file(path, rel, stem, text) {
  return { path, rel, stem, text }
}

const files = [
  file(
    '/vault/index.html',
    'index.html',
    'index',
    '<h1>Home</h1><p>See [[projects/alpha|Alpha]] and [[missing]].</p>'
  ),
  file(
    '/vault/projects/alpha.html',
    'projects/alpha.html',
    'alpha',
    '<h2>Alpha</h2><p>Back to <a class="wikilink" href="index">Home</a>.</p>'
  ),
  file(
    '/vault/projects/beta.html',
    'projects/beta.html',
    'beta',
    '<p>The index of this folder is not a wikilink.</p>'
  ),
  file(
    '/vault/notes/alpha.html',
    'notes/alpha.html',
    'alpha',
    '# Other alpha\n\nSee [[index]].'
  ),
]

const targets = scan.extractWikiTargets(files[0].text)
assert.deepStrictEqual(targets.sort(), ['missing', 'projects/alpha'])

assert.equal(scan.matchWikiFile('projects/alpha', files).path, '/vault/projects/alpha.html')
assert.equal(scan.matchWikiFile('index', files).path, '/vault/index.html')
assert.equal(scan.matchWikiFile('alpha', files), null)
assert.equal(scan.matchWikiFile('nope', files), null)

const headings = scan.extractHeadings(files[0].text)
assert.deepStrictEqual(headings, [{ level: 1, text: 'Home' }])
assert.deepStrictEqual(scan.extractHeadings('# A\n## B'), [
  { level: 1, text: 'A' },
  { level: 2, text: 'B' },
])

const ctx = scan.noteContext('/vault/index.html', files)
assert.deepStrictEqual(
  ctx.outgoing.map((o) => o.target).sort(),
  ['missing', 'projects/alpha']
)
assert.equal(ctx.outgoing.find((o) => o.target === 'missing').path, null)
assert.equal(ctx.outgoing.find((o) => o.target === 'projects/alpha').path, '/vault/projects/alpha.html')
assert.equal(ctx.linked.length, 2)
assert.ok(ctx.linked.some((l) => l.path === '/vault/projects/alpha.html'))
assert.ok(ctx.linked.some((l) => l.path === '/vault/notes/alpha.html'))
assert.equal(ctx.unlinked.length, 1)
assert.equal(ctx.unlinked[0].path, '/vault/projects/beta.html')
assert.ok(/index/i.test(ctx.unlinked[0].snippet))
assert.equal(ctx.graph.current.path, '/vault/index.html')
assert.deepStrictEqual(
  ctx.graph.out.map((n) => n.path),
  ['/vault/projects/alpha.html']
)
assert.equal(ctx.graph.incoming.length, 2)
assert.deepStrictEqual(ctx.graph.unresolved, [{ target: 'missing' }])
assert.deepStrictEqual(ctx.outline, [{ level: 1, text: 'Home' }])

const empty = scan.noteContext('/nope', files)
assert.deepStrictEqual(empty.linked, [])
assert.equal(empty.graph.current, null)

const mentions = scan.wikiMentions('[[a]] and <a class="wikilink" href="b">B</a>')
assert.deepStrictEqual(
  mentions.map((m) => m.target),
  ['a', 'b']
)

const tree = []
scan.flattenFiles(
  [
    {
      name: 'a.html',
      path: '/vault/a.html',
      isDir: false,
    },
    {
      name: 'skip.txt',
      path: '/vault/skip.txt',
      isDir: false,
    },
    {
      name: 'dir',
      path: '/vault/dir',
      isDir: true,
      children: [{ name: 'b.md', path: '/vault/dir/b.md', isDir: false }],
    },
  ],
  '',
  tree
)
assert.deepStrictEqual(
  tree.map((f) => f.rel),
  ['a.html', 'dir/b.md']
)

assert.equal(scan.previewLine('  <p>Hello   world</p>  '), 'Hello world')
assert.equal(scan.cleanTarget(' Folder/Note.html '), 'Folder/Note')

console.log('ok')
