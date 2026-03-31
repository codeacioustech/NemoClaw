const { spawn } = require('child_process');
const p = spawn('wsl', [
  'bash', '-l', '-x', '-c', 
  'export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && echo "sourcing" && . "$NVM_DIR/nvm.sh" && echo "installing" && nvm install 22 && echo "using" && nvm use 22 && node --version && npm --version'
]);
p.stdout.on('data', d => console.log('STDOUT:', d.toString()));
p.stderr.on('data', d => console.log('STDERR:', d.toString()));
p.on('close', c => console.log('CLOSE:', c));
