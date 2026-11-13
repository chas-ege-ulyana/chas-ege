
import os, sys, time, json, re, base64
import concurrent.futures as cf
import requests
TOKEN=os.environ["GH_TOKEN"]
H={"Authorization":f"token {TOKEN}","Accept":"application/vnd.github+json"}
S=requests.Session(); S.headers.update(H)
FORK="chas-ege-ulyana/chas-ege"
STATE_BRANCH="ulyana/audit-state"
STATE_PATH="audit-state.json"
def req(method,url,**kw):
    last=None
    for i in range(8):
        try:
            r=S.request(method,url,timeout=10,**kw)
            if r.status_code in (502,503): time.sleep(1); continue
            if r.status_code in (403,429) and "rate limit" in r.text.lower(): time.sleep(25); continue
            return r
        except Exception as e:
            last=e; time.sleep(0.5)
    raise last
STATE_SHA=None
def load_state():
    global STATE_SHA
    r=req("GET",f"https://api.github.com/repos/{FORK}/contents/{STATE_PATH}",params={"ref":STATE_BRANCH})
    j=r.json(); STATE_SHA=j["sha"]
    return json.loads(base64.b64decode(j["content"]).decode())
def save_state(st):
    global STATE_SHA
    try:
        c=base64.b64encode(json.dumps(st,ensure_ascii=False).encode()).decode()
        r=S.put(f"https://api.github.com/repos/{FORK}/contents/{STATE_PATH}",
                json={"message":"[script] audit state","content":c,"sha":STATE_SHA,"branch":STATE_BRANCH},timeout=15)
        if r.status_code in (200,201): STATE_SHA=r.json()["content"]["sha"]
    except Exception: pass
MOD_RE=re.compile(r'\bmodifiers\s*\.\s*(addCanvasIllustration|variativeABC|allDecimalsToStandard)\s*\(')
def strip_noise(src,bs=False):
    out=list(src); i=0; n=len(src)
    while i<n:
        c=src[i]
        if c in "'\"`":
            q=c; stt=i; i+=1
            while i<n:
                if src[i]=='\\': i+=2; continue
                if src[i]==q: i+=1; break
                i+=1
            if bs:
                for k in range(stt+1,min(i,n)):
                    if out[k]!='\n': out[k]=' '
            continue
        if c=='/' and i+1<n and src[i+1]=='/':
            j=src.find('\n',i); j=n if j==-1 else j
            for k in range(i,j): out[k]=' '
            i=j; continue
        if c=='/' and i+1<n and src[i+1]=='*':
            j=src.find('*/',i+2); j=n if j==-1 else j+2
            for k in range(i,j):
                if out[k]!='\n': out[k]=' '
            i=j; continue
        i+=1
    return ''.join(out)
def analyze(t): return [(m.group(1),m.start()) for m in MOD_RE.finditer(strip_noise(t))]
def violates(calls):
    pos={}
    for nm,p in calls: pos.setdefault(nm,[]).append(p)
    if 'addCanvasIllustration' not in pos: return False
    a=pos['addCanvasIllustration']; v=pos.get('variativeABC'); d=pos.get('allDecimalsToStandard')
    if v and min(a)<max(v): return True
    if d and max(a)>min(d): return True
    return False
def stmt_range(text,clean,ms):
    i=ms
    while i>0 and (text[i-1].isalnum() or text[i-1] in "_$."): i-=1
    ls=text.rfind("\n",0,i)+1
    if text[ls:i].strip(): return None
    op=clean.find("(",ms); depth=0; j=op
    while j<len(clean):
        if clean[j]=="(": depth+=1
        elif clean[j]==")":
            depth-=1
            if depth==0: break
        j+=1
    if depth!=0: return None
    k=j+1
    while k<len(clean) and clean[k] in " \t": k+=1
    end=k+1 if (k<len(clean) and clean[k]==";") else j+1
    le=text.find("\n",end)
    if le==-1: le=len(text)
    if clean[end:le].strip(): return None
    le_excl=le+1 if le<len(text) and text[le]=="\n" else le
    return (ls,le_excl)
def make_fix(text):
    clean=strip_noise(text); calls=analyze(text)
    if not calls or not violates(calls): return None,"no violation"
    names=[n for n,_ in calls]
    if len(names)!=len(set(names)): return None,"duplicate calls"
    rng={}
    for nm,p in calls:
        r=stmt_range(text,clean,p)
        if r is None: return None,nm+": complex"
        rng[nm]=r
    if 'addCanvasIllustration' not in rng: return None,"no canvas"
    cls,cle=rng['addCanvasIllustration']; canvas_block=text[cls:cle]
    move_dec='allDecimalsToStandard' in rng and rng['allDecimalsToStandard'][0]<cls
    move_var='variativeABC' in rng and rng['variativeABC'][0]>cls
    if not move_dec and not move_var: return None,"nothing to move"
    def arg_ids(nm):
        ls,le=rng[nm]; blk=text[ls:le]; op=blk.find("("); inner=blk[op+1:blk.rfind(")")]
        return set(re.findall(r'[A-Za-z_$][\w$]*',inner))
    def decl(region): return set(re.findall(r'\b(?:let|const|var|function)\s+([A-Za-z_$][\w$]*)',region))
    if move_dec:
        ls,le=rng['allDecimalsToStandard']
        if arg_ids('allDecimalsToStandard') & decl(text[le:cle]): return None,"decimals dep"
    if move_var:
        ls,le=rng['variativeABC']
        if arg_ids('variativeABC') & decl(text[cls:ls]): return None,"variative dep"
    specials=sorted([(rng[nm][0],rng[nm][1],nm) for nm in rng]); pieces=[]; prev=0
    for ls,le,nm in specials:
        pieces.append(text[prev:ls])
        if nm=='addCanvasIllustration':
            if move_var: pieces.append(text[rng['variativeABC'][0]:rng['variativeABC'][1]])
            pieces.append(canvas_block)
            if move_dec: pieces.append(text[rng['allDecimalsToStandard'][0]:rng['allDecimalsToStandard'][1]])
        elif nm=='allDecimalsToStandard' and move_dec: pass
        elif nm=='variativeABC' and move_var: pass
        else: pieces.append(text[ls:le])
        prev=le
    pieces.append(text[prev:]); new="".join(pieces)
    if sorted(new.split("\n"))!=sorted(text.split("\n")): return None,"multiset"
    nc=analyze(new)
    if violates(nc) or len(nc)!=len(calls): return None,"bad order"
    return new,{"move_dec":move_dec,"move_var":move_var}
def branch_name(r): return "silentpr/"+r["user"].lower()+"/"+r["ref"]
def get_ref(br):
    r=req("GET",f"https://api.github.com/repos/{FORK}/git/ref/heads/{br}")
    if r.status_code==200: return r.json()["object"]["sha"]
    if r.status_code==404: return None
    raise RuntimeError("ref %s %s"%(br,r.status_code))
def get_file(ref,path):
    r=req("GET",f"https://api.github.com/repos/{FORK}/contents/{path}",params={"ref":ref})
    if r.status_code!=200: return None,None,r.status_code
    j=r.json()
    if j.get("type")=="symlink": return None,None,"symlink"
    if not j.get("content"): return None,None,"empty"
    return base64.b64decode(j["content"]).decode(),j["sha"],200
st=load_state(); SCANR=st["scan"]; FIXLOG=st.setdefault("fixlog",{})
viol=[(k,r) for k,r in sorted(SCANR.items(),key=lambda x:-int(x[0])) if r.get("viol")]
t0=time.time(); done=0; since_save=0
for k,r in viol:
    prev=FIXLOG.get(k,{})
    if prev.get("status")=="done_v2": continue
    br=branch_name(r)
    try:
        head=get_ref(br); replace=False
        if head and prev.get("commit")==head:
            rc=req("GET",f"https://api.github.com/repos/{FORK}/git/commits/{head}"); rc.raise_for_status()
            base=rc.json()["parents"][0]["sha"]; replace=True
        elif head:
            base=head
        else:
            base=r["sha"]
            rr=req("POST",f"https://api.github.com/repos/{FORK}/git/refs",json={"ref":"refs/heads/"+br,"sha":base})
            if rr.status_code not in (200,201): raise RuntimeError("create ref %s"%rr.status_code)
        paths=[v["path"] for v in r["viol"]]
        def prep(path):
            txt,fsha,code=get_file(base,path)
            if txt is None: return (path,None,code)
            new,info=make_fix(txt)
            return (path,new,info)
        with cf.ThreadPoolExecutor(max_workers=12) as ex:
            prepped=list(ex.map(prep,paths))
        cf_files=[]; manual=[]; skip=[]
        for path,new,info in prepped:
            if new is None:
                if info=="no violation": skip.append(path)
                else: manual.append((path,info))
                continue
            cf_files.append((path,new))
        if manual:
            FIXLOG[k]={"status":"manual","branch":br,"manual":manual}; save_state(st)
            print("MANUAL PR",k,manual,flush=True); continue
        if not cf_files:
            FIXLOG[k]={"status":"done_v2","branch":br,"note":"already correct","skip":skip}; save_state(st); done+=1; continue
        msg="[zdn][fix] Порядок модификаторов: addCanvasIllustration после variativeABC и до allDecimalsToStandard"
        if all(not p.startswith("zdn/") for p,_ in cf_files):
            msg="[core][fix] Порядок модификаторов: addCanvasIllustration после variativeABC и до allDecimalsToStandard"
        def mkblob(item):
            path,new=item
            rr=req("POST",f"https://api.github.com/repos/{FORK}/git/blobs",json={"content":base64.b64encode(new.encode()).decode(),"encoding":"base64"})
            rr.raise_for_status()
            return {"path":path,"mode":"100644","type":"blob","sha":rr.json()["sha"]}
        with cf.ThreadPoolExecutor(max_workers=8) as ex:
            blobs=list(ex.map(mkblob,cf_files))
        rc=req("GET",f"https://api.github.com/repos/{FORK}/git/commits/{base}"); rc.raise_for_status()
        rt=req("POST",f"https://api.github.com/repos/{FORK}/git/trees",json={"base_tree":rc.json()["tree"]["sha"],"tree":blobs}); rt.raise_for_status()
        rcommit=req("POST",f"https://api.github.com/repos/{FORK}/git/commits",json={"message":msg,"tree":rt.json()["sha"],"parents":[base]}); rcommit.raise_for_status()
        newsha=rcommit.json()["sha"]
        rup=req("PATCH",f"https://api.github.com/repos/{FORK}/git/refs/heads/{br}",json={"sha":newsha,"force":replace}); rup.raise_for_status()
        FIXLOG[k]={"status":"done_v2","commit":newsha,"branch":br,"files":[p for p,_ in cf_files],"replaced":replace,"skip":skip}
        done+=1; since_save+=1
        print("APPLIED PR",k,br,newsha[:10],"files:",len(cf_files),"replaced:",replace,flush=True)
        if since_save>=4: save_state(st); since_save=0
        time.sleep(1.5)
    except Exception as ex2:
        FIXLOG[k]={"status":"error","error":repr(ex2)}; save_state(st)
        print("ERROR PR",k,repr(ex2),flush=True)
save_state(st)
nd=sum(1 for v in FIXLOG.values() if v.get("status")=="done_v2")
nm=sum(1 for v in FIXLOG.values() if v.get("status")=="manual")
ne=sum(1 for v in FIXLOG.values() if v.get("status")=="error")
print("SUMMARY done_v2 %d manual %d error %d; +%d run"%(nd,nm,ne,done),flush=True)
