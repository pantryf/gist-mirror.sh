const os   = require('os');
const path = require('path');
const {Octokit} = require('@octokit/rest');
const {sleep}   = require('extra-sleep');
const fs = require('extra-fs');




//#region CONSTANTS
//=================

const cwd      = fs.mkdtempSync(os.tmpdir() + '/devtools-gist-mirror-');
const stdio    = [0, 1, 2];

const OPTIONS  = {
  help: false,
  githubToken:    '',
  githubThrottle: 4000,  // 4 seconds
  gistDescriptionMatch:   /.*/,
  gistFilenameMatch:      /.*/,
  repoNameMatch:          /.*/,
  repoNameReplace:        '$&',
  repoDescriptionMatch:   /.*/,
  repoDescriptionReplace: '$&',
  org: '',
};

const HELP = '' +
`Usage:
$ devtools-gist-mirror [options] <org>
  --help                        Show this help message.
  --gist-description-match      Regex to match gist description.
  --gist-filename-match         Regex to match gist filename.
  --repo-name-match             Regex to match repo name.
  --repo-name-replace           Replace repo name.
  --repo-description-match      Regex to match repo description.
  --repo-description-replace    Replace repo description.
  <org>                         Org to mirror to.

Environment Variables:
  $GITHUB_TOKEN                 GitHub token.
  $GITHUB_THROTTLE              Throttle time in milliseconds.
`;
//#endregion




//#region METHODS
//===============

//#region GIT OPERATIONS
//-----------------------

// Get default branch of a git repo.
async function gitDefaultBranch(repo) {
  var ref = await cp.exec(`git rev-parse --abbrev-ref origin/HEAD`, {cwd: repo});
  return ref.stdout.trim().replace(/^.+?\//, '');
}
//#endregion




//#region GIST OPERATIONS
//-----------------------

/**
 * Fetch user's public gists, and filter by filename and description (regex).
 * @param {Octokit} octokit github api client
 * @param {object} options options {gistFilenameMatch, gistDescriptionMatch, githubThrottle}
 * @param {Function?} onGist called on each gist (gist)
 * @returns {Promise<object[]>} array of matching gists
 */
async function fetchGists(octokit, options, onGist) {
  var gists = [], per_page = 100;
  var o = Object.assign({}, OPTIONS, options);
  for (var page=0;; ++page) {
    // Fetch a page of gists for user.
    var res = await octokit.gists.list({per_page, page});
    // Filter gists by filename and description.
    var someGists = res.data.filter(gist => {
      if (!gist.public) return false;
      if (!o.gistDescriptionMatch.test(gist.description)) return false;
      for (var file in gist.files)
        if (o.gistFilenameMatch.test(file)) return true;
      return false;
    });
    // Invoke callback on each gist.
    if (onGist) for (var gist of someGists)
      onGist(gist);
    // Accumulate gists.
    gists.push(...someGists);
    console.error(`Found ${gists.length} matching gists...`);
    // Stop if less than a page of gists was returned.
    if (res.data.length < per_page) break;
    // Throttle requests.
    await sleep(o.githubThrottle);
  }
  console.error(`Found a total of ${gists.length} matching gists.`);
  return gists;
}


/**
 * Mirror each gist to an org by updating an existing repository, or creating a new repository if it doesn't exist.
 * @param {Octokit} octokit github api client
 * @param {object[]} gists array of gists to mirror
 * @param {object} options options {githubThrottle}
 * @returns {Promise<[object, object][]>} array of pairs of gists [sourceGist, targetGist]
 */
async function mirrorGists(octokit, gists, options) {
  var o = Object.assign({}, OPTIONS, options);
  var gistRepos = [];
  // Create a temporary directory to clone repos into.
  var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), '/script-gist-mirror-'));
  // For each gist, clone it, copy files to a new gist, and delete the old gist.
  for (var gist of gists) {
    var isPartial = !gist.html_url;
    // Fetch the gist if it is not fully populated.
    if (isPartial) {
      var res = await octokit.gists.get({gist_id: gist.id});
      gist = res.data;
    }
    console.error(`Mirroring gist ${gist.id} ...`);
    console.error(gistDetails(gist));
    // Check if the gist has already been mirrored.
    var name = Object.keys(gist.files)[0].replace(o.repoNameMatch, o.repoNameReplace).replace(/\..+$/, '');
    var description = gist.description.replace(o.repoDescriptionMatch, o.repoDescriptionReplace);
    var repoUrl = `https://github.com/${o.org}/${name}`;
    var res = null, repoExists = true;
    try { res = await octokit.repos.get({owner: o.org, repo: name}); }
    catch (err) { repoExists = false; }
    // Create a new gist with the same files as the source gist, but empty.
    var files = {};
    for (var file in gist.files)
      files[file] = {content: 'EMPTY'};
    // Create a new gist with the same description as the source gist.
    var {description} = gist;
    if (isPartial) await sleep(o.githubThrottle);
    var res = await octokit.gists.create({public: false, description, files});
    var targetGist = res.data;
    // Clone the source gist, copy files to the target gist, and push.
    cp.execSync(`git clone ${gist.git_pull_url} source_gist`, {cwd: tempDir});
    cp.execSync(`git clone ${targetGist.git_pull_url} target_gist`, {cwd: tempDir});
    cp.execSync(`cp -r source_gist/* target_gist/`, {cwd: tempDir});
    cp.execSync(`cd target_gist && git add . && git commit -m "conceal gist" && git push`, {cwd: tempDir});
    cp.execSync(`rm -rf source_gist target_gist`, {cwd: tempDir});
    console.error();
    // Delete the source gist.
    await octokit.gists.delete({gist_id: gist.id});
    await sleep(o.githubThrottle);
    // Add the pair of gists to the list.
    gistRepos.push([gist, targetGist]);
    // Share details of the target gist.
    console.error(`Concealed gist ${gist.id} as ${targetGist.id}.`);
    console.error(gistDetails(targetGist));
    console.error();
  }
  // Remove the temporary directory.
  fs.rmdirSync(tempDir);
  return gistRepos;
}


// Mirror gist to an org.
async function mirrorGist(octokit, gist, o) {
  // Create repo in org.
  var name = Object.keys(gist.files)[0].replace(o.repoNameMatch, o.repoNameReplace).replace(/\..+$/, '');
  var description = gist.description.replace(o.repoDescriptionMatch, o.repoDescriptionReplace);
  console.log(`Creating repo ${o.org}/${name} ...`);
  try { await octokit.repos.createInOrg({org: o.org, name, description, homepage: gist.html_url}); }
  catch (err) { console.error(err); return; }
  // Push gist to repo.
  console.log(`Pushing gist to repo ${o.org}/${name} ...`);
  var repoCwd = path.join(cwd, name);
  cp.execSync(`git clone ${gist.html_url} ${name}`, {stdio, cwd});
  cp.execSync(`git remote add upstream https://github.com/${o.org}/${name}`, {stdio, cwd: repoCwd});
  cp.execSync(`git push -u upstream main`, {stdio, cwd: repoCwd});
  fs.rmdirSync(repoCwd, {recursive: true});
}


// Mirror gists to an org.
async function mirrorGists(octokit, gists, o) {
  for (var i=0; i<gists.length; ++i) {
    var gist = gists[i];
    console.log(`Mirroring gist ${gist.id} [${i+1} of ${gists.length}] ...`);
    console.log(`  description: ${gist.description}`);
    console.log(`  url: ${gist.html_url}\n`);
    await mirrorGist(octokit, gist, o);
    console.log(`Mirrored gist ${gist.id}.\n`)
    await sleep(o.githubThrottle);
  }
}
//#endregion




//#region MAIN
//------------

// Parse command line arguments.
function parseArguments(o, a, i) {
  if (a[i]==='--help') o.help = true;
  else if (a[i]==='--github-token')    o.githubToken    = a[++i];
  else if (a[i]==='--github-throttle') o.githubThrottle = parseFloat(a[++i]);
  else if (a[i]==='--gist-description-match')   o.gistDescriptionMatch   = new RegExp(a[++i]);
  else if (a[i]==='--gist-filename-match')      o.gistFilenameMatch      = new RegExp(a[++i]);
  else if (a[i]==='--repo-name-match')          o.repoNameMatch          = new RegExp(a[++i]);
  else if (a[i]==='--repo-name-replace')        o.repoNameReplace        = a[++i];
  else if (a[i]==='--repo-description-match')   o.repoDescriptionMatch   = new RegExp(a[++i]);
  else if (a[i]==='--repo-description-replace') o.repoDescriptionReplace = a[++i];
  else if (a[i].startsWith('--')) o.error = `Unknown option: ${a[i]}`;
  else o.org = a[i];
  return ++i;
}


// Parse environment variables.
function parseEnvironment(o, e) {
  if (e.GITHUB_TOKEN)    o.githubToken    = e.GITHUB_TOKEN;
  if (e.GITHUB_THROTTLE) o.githubThrottle = parseFloat(e.GITHUB_THROTTLE);
}


// Validate command line options.
function validateOptions(o) {
  if (!o.org)         o.error = 'Missing org to mirror to!';
  if (!o.githubToken) o.error = 'Missing GitHub token!';
  if (o.githubThrottle < 0) o.error = 'GitHub throttle must be >= 0!';
}


async function main() {
  const E = process.env;
  const A = process.argv;
  var o = Object.assign({}, OPTIONS);
  for (var i=2; i<A.length;)
    i = parseArguments(o, A, i);
  parseEnvironment(o, E);
  validateOptions(o);
  if (o.help)  { console.log(HELP);      return; }
  if (o.error) { console.error(o.error); return; }
  var octokit = new Octokit({auth: o.githubToken});
  var gists = await fetchGists(octokit, o);
  var gists = filterGists(gists, o);
  await mirrorGists(octokit, gists, o);
}
main();
//#endregion
//#endregion
