// Exact incident remediation. No secrets are emitted. Run as root with service stopped.
import fs from 'node:fs';
const file='/etc/robinhood-lp-bot.env';
const router='0x6131B5fae19EA4f9D964eAc0408E4408b66337b5';
const key='KYBERSWAP_ROUTER_ADDRESS';
const original=fs.readFileSync(file,'utf8');
const rows=original.split(/\r?\n/),matches=rows.filter(l=>l.startsWith(key+'='));
if(matches.length>1)throw Error('Duplicate router setting; stop for review');
if(matches.length&&matches[0].slice(key.length+1).trim()&&!['""',"''",router].includes(matches[0].slice(key.length+1).trim()))throw Error('Existing non-empty router must be reviewed, not overwritten');
if(!process.argv.includes('--apply')){console.log('Dry run: exact verified Robinhood Kyber V2 router is ready to configure');process.exit(0);}
const backup=file+'.backup-funding-'+Date.now();
fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,0o600);
const next=rows.filter(l=>!l.startsWith(key+'=')).join('\n').replace(/\n*$/,'\n')+key+'='+router+'\n';
fs.writeFileSync(file+'.funding-tmp',next,{mode:0o600,flag:'wx'});fs.renameSync(file+'.funding-tmp',file);
console.log('Verified router configured; protected backup created. No other environment setting changed.');
