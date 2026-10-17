import xterm from '@xterm/headless';
export class Codec {
 constructor(cols,rows,{cell={width:9,height:18},kitty=0,colors={}}={}) {
  this.term=new xterm.Terminal({cols,rows,scrollback:5000,allowProposedApi:true,windowOptions:{getCellSizePixels:true,getWinSizeChars:true}});this.offset=null;this.cell=cell;this.kitty=kitty;this.kittySupported=kitty>0;this.kittyStack=[];this.modifyOtherKeys=0;this.colors=colors;this.hidden=false;this.mouse=new Set();this.replies=[];
  this.term.onData(s=>this.replies.push(s));
  const p=this.term.parser;
  p.registerCsiHandler({final:'t'},args=>{let s;switch(args[0]){case 16:s=`\x1b[6;${this.cell.height};${this.cell.width}t`;break;case 18:s=`\x1b[8;${this.term.rows};${this.term.cols}t`;break;default:return false;}this.replies.push(s);return true;});
  p.registerCsiHandler({prefix:'?',final:'u'},()=>{if(this.kittySupported)this.replies.push(`\x1b[?${this.kitty}u`);return true;});
  for(const prefix of ['>','<','='])p.registerCsiHandler({prefix,final:'u'},args=>{if(!this.kittySupported)return true;if(prefix==='>'){this.kittyStack.push(this.kitty);this.kitty=args[0]||0;}else if(prefix==='<'){for(let i=0;i<(args[0]||1);i++)this.kitty=this.kittyStack.pop()??0;}else{const v=args[0]||0;this.kitty=args[1]===2?this.kitty|v:args[1]===3?this.kitty&~v:v;}return true;});
  p.registerCsiHandler({prefix:'>',final:'m'},args=>{if(args[0]===4){this.modifyOtherKeys=args[1]||0;return true;}return false;});
  for(const n of [10,11])p.registerOscHandler(n,data=>{if(data!=='?')return false;const rgb=this.colors[n===10?'foreground':'background'];if(rgb){const hex=v=>Math.round(v).toString(16).padStart(2,'0').repeat(2);this.replies.push(`\x1b]${n};rgb:${hex(rgb.r)}/${hex(rgb.g)}/${hex(rgb.b)}\x1b\\`);}return true;});
  for(const final of ['h','l'])p.registerCsiHandler({prefix:'?',final},args=>{for(const n of args){if([1000,1002,1003,1006].includes(n)){if(final==='h')this.mouse.add(n);else this.mouse.delete(n);}if(n===25)this.hidden=final==='l';}return false;});
 }
 write(s){return new Promise(r=>this.term.write(s,r));}
 resize(cols,rows){this.term.resize(cols,rows);}
 scroll(delta){const b=this.term.buffer.active;this.offset=Math.max(0,Math.min(b.baseY,(this.offset??b.baseY)+delta));}
 follow(){this.offset=null;}
 // Exact 5.5.0 internal URI seam: cells carry link IDs, never the last-seen URI.
 uri(x,y){const c=this.term.buffer.active.getLine(y)?.getCell(x);const id=c?.extended?.urlId;return id?this.term._core._oscLinkService.getLinkData(id)?.uri:undefined;}
 lines(marker=''){
  const b=this.term.buffer.active, start=b.type==='alternate'?0:Math.min(this.offset??b.baseY,b.baseY);const lines=[];
  for(let row=0;row<this.term.rows;row++) {let out='',link;const line=b.getLine(start+row);for(let x=0;x<this.term.cols;x++){const c=line?.getCell(x);if(!c)break;if(c.getWidth()===0)continue;const uri=this.uri(x,start+row);if(uri!==link){if(link)out+='\x1b]8;;\x1b\\';if(uri)out+='\x1b]8;;'+uri.replace(/[\x00-\x1f\x7f]/g,'')+'\x1b\\';link=uri;}
   const sgr=[0];for(const [method,n] of [['isBold',1],['isDim',2],['isItalic',3],['isUnderline',4],['isBlink',5],['isInverse',7],['isInvisible',8],['isStrikethrough',9]])if(c[method]())sgr.push(n);
   for(const [p,n] of [['Fg',38],['Bg',48]]){const v=c['get'+p+'Color']();if(c['is'+p+'RGB']())sgr.push(n,2,(v>>16)&255,(v>>8)&255,v&255);else if(c['is'+p+'Palette']())sgr.push(n,5,v);}
   if(!this.hidden&&start===b.baseY&&row===b.cursorY&&x===b.cursorX)out+=marker;out+='\x1b['+sgr.join(';')+'m'+(c.getChars()||' ');
  }if(link)out+='\x1b]8;;\x1b\\';lines.push(out+'\x1b[0m');}return lines;
 }
 plain(){return this.lines().map(s=>s.replace(/\x1b\]8;[^\x1b]*\x1b\\/g,'').replace(/\x1b\[[0-9;]*m/g,'')).join('\n');}
 dispose(){this.term.dispose();}
}
