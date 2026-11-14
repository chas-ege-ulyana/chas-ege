
import os,sys,time,json,re,base64,posixpath
import concurrent.futures as cf
import requests
TOKEN=os.environ["GH_TOKEN"]
H={"Authorization":f"token {TOKEN}","Accept":"application/vnd.github+json"}
S=requests.Session(); S.headers.update(H)
FORK="chas-ege-ulyana/chas-ege"; SB="ulyana/audit-state"; SP="audit-state.json"
def req(m,u,**kw):
    last=None
    for i in range(8):
        try:
            r=S.request(m,u,timeout=12,**kw)
            if r.status_code in (502,503): time.sleep(1); continue
            if r.status_code in (403,429) and "rate limit" in r.text.lower(): time.sleep(25); continue
            return r
        except Exception as e: last=e; time.sleep(0.5)
    raise last
SHA=None
def load_state():
    global SHA
    j=req("GET",f"https://api.github.com/repos/{FORK}/contents/{SP}",params={"ref":SB}).json(); SHA=j["sha"]
    return json.loads(base64.b64decode(j["content"]).decode())
def save_state(st):
    global SHA
    try:
        c=base64.b64encode(json.dumps(st,ensure_ascii=False).encode()).decode()
        r=S.put(f"https://api.github.com/repos/{FORK}/contents/{SP}",json={"message":"[script] audit state","content":c,"sha":SHA,"branch":SB},timeout=15)
        if r.status_code in (200,201): SHA=r.json()["content"]["sha"]
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
    return (ls,le+1 if le<len(text) and text[le]=="\n" else le)
def make_fix(text):
    clean=strip_noise(text); calls=analyze(text)
    if not calls or not violates(calls): return None,"no violation"
    names=[n for n,_ in calls]
    if len(names)!=len(set(names)): return None,"duplicate"
    rng={}
    for nm,p in calls:
        r=stmt_range(text,clean,p)
        if r is None: return None,nm+":complex"
        rng[nm]=r
    if 'addCanvasIllustration' not in rng: return None,"no canvas"
    cls,cle=rng['addCanvasIllustration']; cb=text[cls:cle]
    md='allDecimalsToStandard' in rng and rng['allDecimalsToStandard'][0]<cls
    mv='variativeABC' in rng and rng['variativeABC'][0]>cls
    if not md and not mv: return None,"nothing"
    def aids(nm):
        ls,le=rng[nm]; b=text[ls:le]; op=b.find("("); inner=b[op+1:b.rfind(")")]
        return set(re.findall(r'[A-Za-z_$][\w$]*',inner))
    def decl(reg): return set(re.findall(r'\b(?:let|const|var|function)\s+([A-Za-z_$][\w$]*)',reg))
    if md:
        ls,le=rng['allDecimalsToStandard']
        if aids('allDecimalsToStandard')&decl(text[le:cle]): return None,"dec dep"
    if mv:
        ls,le=rng['variativeABC']
        if aids('variativeABC')&decl(text[cls:ls]): return None,"var dep"
    sp=sorted([(rng[nm][0],rng[nm][1],nm) for nm in rng]); pieces=[]; prev=0
    for ls,le,nm in sp:
        pieces.append(text[prev:ls])
        if nm=='addCanvasIllustration':
            if mv: pieces.append(text[rng['variativeABC'][0]:rng['variativeABC'][1]])
            pieces.append(cb)
            if md: pieces.append(text[rng['allDecimalsToStandard'][0]:rng['allDecimalsToStandard'][1]])
        elif nm=='allDecimalsToStandard' and md: pass
        elif nm=='variativeABC' and mv: pass
        else: pieces.append(text[ls:le])
        prev=le
    pieces.append(text[prev:]); new="".join(pieces)
    if sorted(new.split("\n"))!=sorted(text.split("\n")): return None,"multiset"
    nc=analyze(new)
    if violates(nc) or len(nc)!=len(calls): return None,"bad order"
    return new,"ok"
def mode_map(repo,sha):
    rc=req("GET",f"https://api.github.com/repos/{repo}/git/commits/{sha}").json()
    rt=req("GET",f"https://api.github.com/repos/{repo}/git/trees/{rc['tree']['sha']}",params={"recursive":1}).json()
    return {e["path"]:(e["mode"],e["sha"]) for e in rt["tree"]}, rc["tree"]["sha"]
def blob_text(repo,sha):
    j=req("GET",f"https://api.github.com/repos/{repo}/git/blobs/{sha}").json()
    return base64.b64decode(j["content"]).decode("utf-8","replace")
def resolve(repo,path,MODE,depth=0):
    if depth>10: return path
    m=MODE.get(path)
    if not m: return path
    if m[0]=="120000":
        tgt=posixpath.normpath(posixpath.join(posixpath.dirname(path),blob_text(repo,m[1])))
        return resolve(repo,tgt,MODE,depth+1)
    return path
st=load_state(); FL=st.setdefault("fixlog",{})
for k in ["1599","1588"]:
    if FL.get(k,{}).get("status")=="giant_done": continue
    sc=st["scan"][k]; repo=sc["repo"]; sha=sc["sha"]; br="silentpr/"+sc["user"].lower()+"/"+sc["ref"]
    try:
        MODE,root_tree=mode_map(repo,sha)
        viol=[v["path"] for v in sc["viol"]]
        real=set(p for p in viol if MODE.get(p,("?",))[0]=="100644")
        sym=[p for p in viol if MODE.get(p,("?",))[0]=="120000"]
        # resolve symlinks -> targets; добавляем реальные цели с нарушениями
        def res(p): return resolve(repo,p,MODE)
        with cf.ThreadPoolExecutor(max_workers=16) as ex:
            targets=list(ex.map(res,sym))
        real=sorted(real)
        realset=set(real)
        covered=sum(1 for t in targets if t in realset)
        uncovered=sorted(set(t for t in targets if t not in realset))
        # фиксим только реальные файлы
        def prep(p):
            txt=blob_text(repo,MODE[p][1])
            new,info=make_fix(txt)
            return (p,new,info)
        with cf.ThreadPoolExecutor(max_workers=12) as ex:
            prepped=list(ex.map(prep,real))
        commits=[]; manual=[]; skip=[]
        for p,new,info in prepped:
            if new is None:
                (skip if info=="no violation" else manual).append((p,info))
            else: commits.append((p,new))
        if manual:
            FL[k]={"status":"giant_manual","manual":manual}; save_state(st); print("MANUAL",k,manual,flush=True); continue
        # blob'ы только для реальных файлов (mode 100644) — симлинки не трогаем
        def mk(item):
            p,new=item
            rr=req("POST",f"https://api.github.com/repos/{FORK}/git/blobs",json={"content":base64.b64encode(new.encode()).decode(),"encoding":"base64"}); rr.raise_for_status()
            assert MODE[p][0]=="100644"
            return {"path":p,"mode":"100644","type":"blob","sha":rr.json()["sha"]}
        with cf.ThreadPoolExecutor(max_workers=8) as ex:
            blobs=list(ex.map(mk,commits))
        rt=req("POST",f"https://api.github.com/repos/{FORK}/git/trees",json={"base_tree":root_tree,"tree":blobs}); rt.raise_for_status()
        msg="[zdn][fix] Порядок модификаторов: addCanvasIllustration после variativeABC и до allDecimalsToStandard (только реальные файлы, симлинки сохранены)"
        rcommit=req("POST",f"https://api.github.com/repos/{FORK}/git/commits",json={"message":msg,"tree":rt.json()["sha"],"parents":[sha]}); rcommit.raise_for_status()
        newsha=rcommit.json()["sha"]
        # ветка сейчас на голове PR (откат) — обновляем на новый коммит
        rup=req("PATCH",f"https://api.github.com/repos/{FORK}/git/refs/heads/{br}",json={"sha":newsha,"force":True}); rup.raise_for_status()
        FL[k]={"status":"giant_done","commit":newsha,"branch":br,"real_files":len(commits),"symlinks_preserved":len(sym),"sym_targets_covered":covered,"skip":skip,"uncovered":uncovered}
        save_state(st)
        print("GIANT DONE",k,br,newsha[:12],"real:",len(commits),"symlinks preserved:",len(sym),"covered:",covered,"uncovered:",uncovered,flush=True)
    except Exception as e:
        FL[k]={"status":"giant_error","error":repr(e)}; save_state(st); print("ERROR",k,repr(e),flush=True)
print("GIANTS SUMMARY", {k:FL.get(k,{}).get("status") for k in ["1599","1588"]},flush=True)
