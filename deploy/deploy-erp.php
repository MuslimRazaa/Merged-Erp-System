<?php
/**
 * ERP deploy webhook — same pattern as ISO backend's deploy.php.
 * GitHub Actions (.github/workflows/deploy.yml) calls this URL after every
 * push to main. It pulls the latest code, reinstalls dependencies, and
 * restarts the cPanel Node.js App.
 *
 * SETUP (do this once, by hand, on the server — none of this runs itself):
 *   1. Fill in $SECRET below with a long random string
 *      (e.g. generate one with: openssl rand -hex 32)
 *      and put the SAME string in GitHub -> this repo -> Settings ->
 *      Secrets and variables -> Actions -> New secret -> DEPLOY_SECRET_ERP.
 *   2. Fill in $REPO_DIR, $APP_DIR and $VENV_ACTIVATE below — cPanel shows
 *      you the exact venv activate command on the "Setup Node.js App" page
 *      for this application (click the app -> top of the page has a line
 *      like "source /home/USER/nodevenv/erp-ptis/backend/18/bin/activate
 *      && cd /home/USER/erp-ptis/backend"). Copy it from there — don't
 *      guess the Node version number.
 *   3. Upload this file to the server. Prefer a location OUTSIDE
 *      public_html if your hosting allows it; if it must be inside
 *      public_html, keep the filename obscure and the secret long —
 *      anyone with the URL + secret can trigger a deploy.
 *   4. In cPanel -> Git Version Control, clone the new erp-ptis GitHub
 *      repo into $REPO_DIR (this is what makes `git pull` here work).
 */

$SECRET = 'CHANGE-ME-generate-with-openssl-rand--hex-32';

if (!hash_equals($SECRET, $_GET['secret'] ?? '')) {
    http_response_code(403);
    exit('Forbidden');
}

// ---- adjust these three to your actual cPanel paths ----
$REPO_DIR       = '/home/CPANELUSER/erp-ptis';                                      // where `Git Version Control` cloned the repo
$APP_DIR        = $REPO_DIR . '/backend';                                            // the Node.js App's "Application root"
$VENV_ACTIVATE  = '/home/CPANELUSER/nodevenv/erp-ptis/backend/18/bin/activate';       // exact line cPanel's Node.js App page shows you
// ----------------------------------------------------------

header('Content-Type: text/plain');

function run($cmd) {
    echo "\$ $cmd\n";
    echo shell_exec($cmd . ' 2>&1') . "\n";
}

run("cd " . escapeshellarg($REPO_DIR) . " && git pull origin main");
run("source " . escapeshellarg($VENV_ACTIVATE) . " && cd " . escapeshellarg($APP_DIR) . " && npm install --omit=dev");
run("node " . escapeshellarg($APP_DIR . '/migrate.js')); // safe to re-run — additive only, never touches ISO tables
run("mkdir -p " . escapeshellarg($APP_DIR . '/tmp') . " && touch " . escapeshellarg($APP_DIR . '/tmp/restart.txt'));

echo "Deploy complete.\n";
