#!/usr/bin/env python3
import os, pathlib, re, shutil

APK = pathlib.Path(__file__).resolve().parent
ROOT = APK.parent
WWW = APK / "www"

if WWW.exists():
    shutil.rmtree(WWW)
WWW.mkdir(parents=True)

for d in ("PackMusic", "PackSFXTanks"):
    src = ROOT / d
    if not src.exists():
        raise SystemExit(f"Missing resource directory: {src}")
    shutil.copytree(src, WWW / d)

s = (ROOT / "index.html").read_text(encoding="utf-8")
m = re.search(r"const GAME_VERSION='([^']+)'", s)
if not m:
    raise SystemExit("GAME_VERSION not found")
version = m.group(1)
build_number = int(os.environ.get('SF_BUILD', '0') or 0)

def sub(old, new):
    global s
    if old not in s:
        raise SystemExit("PATCH FAILED: " + old[:100])
    s = s.replace(old, new, 1)

sub('<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js" defer></script>',
    '<script>window.__STEEL_FRONTIER_APP__=true;</script>')
sub('async function cgInit(){\n',
    'async function cgInit(){\n  if(window.__STEEL_FRONTIER_APP__){CG.ready=false;CG.on=false;await initPersistence();return}\n')
sub('function srvAddr(){\n',
    "function srvAddr(){\n  if(window.__STEEL_FRONTIER_APP__)return 'steel-frontier.onrender.com';\n")
s = s.replace("if(/^https?:$/.test(location.protocol)",
              "if(!window.__STEEL_FRONTIER_APP__&&/^https?:$/.test(location.protocol)")

update_js = r"""
<script>
(function(){
  if(!window.__STEEL_FRONTIER_APP__)return;
  var CURRENT_VERSION='__VERSION__';
  var CURRENT_BUILD=Number('__BUILD__')||0;
  var ENDPOINT='https://raw.githubusercontent.com/ammambouy-ux/Tank-game/main/apk/latest.json';
  var shown=false;

  function ver(v){
    var a=String(v||'0').split('.').map(function(x){return parseInt(x,10)||0});
    return a[0]*1000000+a[1]*1000+a[2];
  }

  function style(){
    if(document.getElementById('sf-update-style'))return;
    var st=document.createElement('style');
    st.id='sf-update-style';
    st.textContent='#sf-update{position:fixed;inset:0;z-index:250;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.78);padding:20px;text-align:center}#sf-update.show{display:flex}#sf-update .box{width:min(92vw,420px);background:#2c3a22;border:3px solid var(--acc);box-shadow:0 8px 0 #000;padding:22px 18px;box-sizing:border-box}#sf-update h2{margin:0 0 10px;color:var(--acc);font-size:34px;font-weight:400;text-shadow:2px 2px 0 #000}#sf-update p{margin:0 0 16px;font-family:system-ui,sans-serif;font-size:15px;line-height:1.45}#sf-update .ver{color:#7dc4ff;font-weight:700}#sf-update .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}#sf-update button{font-size:18px;padding:10px 20px}#sf-update .later{background:#2b3a22;color:var(--fg);box-shadow:0 4px 0 #000}';
    document.head.appendChild(st);
  }

  function show(info){
    if(shown)return;
    var updateKey=String(info.version)+':'+String(info.build||0);
    if(localStorage.getItem('sf_apk_update_later')===updateKey)return;
    shown=true;
    style();
    var el=document.getElementById('sf-update');
    if(!el){
      el=document.createElement('div');
      el.id='sf-update';
      document.body.appendChild(el);
    }
    var notes=String(info.notes||'Автоматическое обновление игры.').replace(/[<>]/g,'');
    el.innerHTML='<div class="box"><h2>ДОСТУПНО ОБНОВЛЕНИЕ</h2><p>Установить новую версию <span class="ver">'+info.version+'</span>?</p><p style="opacity:.7;font-size:13px">'+notes+'</p><div class="btns"><button id="sf-update-now">ОБНОВИТЬ</button><button id="sf-update-later" class="later">ПОЗЖЕ</button></div></div>';
    el.classList.add('show');
    document.getElementById('sf-update-later').onclick=function(){
      localStorage.setItem('sf_apk_update_later',updateKey);
      el.classList.remove('show');
      shown=false;
    };
    document.getElementById('sf-update-now').onclick=async function(){
      var url=String(info.apkUrl||'');
      if(!/^https:\/\//.test(url))return;
      try{
        var App=window.Capacitor&&window.Capacitor.Plugins&&window.Capacitor.Plugins.App;
        if(App&&App.openUrl){await App.openUrl({url:url});}
        else{window.open(url,'_blank');}
      }catch(e){try{window.open(url,'_blank');}catch(_){}}
    };
  }

  async function check(){
    try{
      var r=await fetch(ENDPOINT+'?v='+Date.now(),{cache:'no-store'});
      if(!r.ok)return;
      var info=await r.json();
      if(info&&info.version&&info.apkUrl&&(ver(info.version)>ver(CURRENT_VERSION)||Number(info.build||0)>CURRENT_BUILD))show(info);
    }catch(e){}
  }

  setTimeout(check,5000);
  setInterval(check,60000);
  document.addEventListener('visibilitychange',function(){if(!document.hidden)check();});
})();
</script>
"""
update_js = update_js.replace("__VERSION__", version).replace("__BUILD__", str(build_number))
s = s.replace("</body>", update_js + "</body>", 1)

(WWW / "index.html").write_text(s, encoding="utf-8")
print(f"Prepared APK web bundle for Steel Frontier {version} build {build_number}")
