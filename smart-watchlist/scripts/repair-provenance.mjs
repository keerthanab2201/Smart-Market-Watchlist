import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(app);
const dbPath=process.env.SW_DB_PATH || path.join(process.env.SW_DATA_DIR || path.join(app,'.data'),'watchlist.sqlite');
const backup=dbPath+'.before-provenance-'+Date.now()+'.bak';
const raw=new DatabaseSync(dbPath);
raw.exec(`VACUUM INTO '${backup.replaceAll("'","''")}'`);raw.close();
process.env.SW_DB_PATH=dbPath;
const d=await import(pathToFileURL(app+'/src/lib/db.ts'));
const scoring=await import(pathToFileURL(app+'/src/lib/score.ts'));
const cleanup=d.collapseDuplicateObservations();
let rebuilt=0;
d.tx(h=>{
 // Finnhub /quote never supplies volume. Legacy zeroes represented missing data.
 h.prepare("UPDATE quotes SET volume=NULL WHERE namespace='live' AND source='finnhub' AND volume=0").run();
 for(const {symbol} of h.prepare("SELECT DISTINCT symbol FROM quotes WHERE namespace='live'").all()){
  const source=d.displaySource('live',symbol);
  const rows=d.recentQuotes('live',symbol,100000,source);
  h.prepare("DELETE FROM symbol_samples WHERE namespace='live' AND symbol=?").run(symbol);
  const closes=[];let prev=null;
  for(const q of rows){
   const b=d.readBaseline('live',symbol);closes.push(q.price);
   const s=scoring.scoreQuote({price:q.price,prevPrice:prev,volume:q.volume??0,nRet:b.n_ret,stdRet:b.std_ret,nVol:b.n_vol,avgVol:b.avg_vol,rangeHi:b.range_hi,rangeLo:b.range_lo,rangeN:b.range_n,closes:closes.slice(-7)});
   h.prepare("DELETE FROM quote_scores WHERE namespace='live' AND symbol=? AND quote_id=?").run(symbol,q.id);
   d.storeScore('live',symbol,q.id,{score:s.total,components:JSON.stringify(s.components),missing:JSON.stringify(s.missing),version:s.version,inputs:JSON.stringify(s.inputs),evidence:JSON.stringify({price:q.price,prevPrice:prev,rangeHi:b.range_hi,rangeLo:b.range_lo,nRet:b.n_ret,rangeN:b.range_n})});
   d.observeSample('live',symbol,q.price,q.volume,prev);prev=q.price;rebuilt++;
  }
 }
 d.setMeta('provenance_repair',JSON.stringify({at:new Date().toISOString(),backup,rebuilt,cleanup}));
});
console.log(JSON.stringify({backup,cleanup,rebuilt,tesla:d.displayQuote('live','TSLA'),personalBaselines:d.db().prepare("SELECT b.price,b.source,b.membership_id FROM item_baselines b JOIN watchlists w ON w.id=b.watchlist_id WHERE b.symbol='TSLA' AND w.is_demo=0").all()}));
