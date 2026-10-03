import { spawn, execFile } from 'child_process';

const limitMb = Number(process.env.WEB_RSS_MB || 700);
let child = null;

function rss(pid, cb) {
  if (process.platform === 'win32') {
    execFile('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], (err, out) => {
      if (err || !out) return cb(0);
      const parts = out.trim().split(',');
      const kb = Number(String(parts[4] || '').replace(/[^\d]/g, ''));
      cb(kb / 1024);
    });
    return;
  }
  execFile('ps', ['-o', 'rss=', '-p', String(pid)], (err, out) => cb(err ? 0 : Number(out) / 1024));
}

function start() {
  child = spawn(process.execPath, ['--max-old-space-size=768', 'src/web/server.js'], { stdio: 'inherit' });
  console.log('watch web pid ' + child.pid + ' cap ' + limitMb + 'MB');
  const mem = setInterval(() => {
    if (!child || child.exitCode != null) return;
    rss(child.pid, (mb) => {
      if (mb > limitMb) {
        console.warn('web rss ' + mb.toFixed(0) + 'MB > ' + limitMb + ', restarting');
        child.kill('SIGTERM');
      }
    });
  }, 10000);
  child.on('exit', (code) => {
    clearInterval(mem);
    console.warn('web exited ' + code + ', restarting');
    setTimeout(start, 1000);
  });
}

start();
