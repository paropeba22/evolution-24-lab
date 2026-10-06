'use strict';
// Restricted CHECK expression trees. Parentheses/Boolean grouping are retained;
// only catalog casts preserving these VARCHAR/integer predicates are accepted.
function normalize(text) {
  try {
    const tokens=[];let rest=text.trim();
    while(rest){
      const m=/^(\s+|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|::|>=|<=|<>|[()\[\],=><]|\d+|[a-zA-Z_][a-zA-Z_0-9]*)/.exec(rest);
      if(!m)throw Error('token');rest=rest.slice(m[0].length);if(!m[0].trim())continue;
      const raw=m[0];
      if(raw.startsWith("'"))tokens.push({type:'text',value:raw.slice(1,-1).replaceAll("''","'")});
      else if(raw.startsWith('"')||raw.startsWith('`'))tokens.push({type:'column',value:raw.slice(1,-1)});
      else if(/^\d+$/.test(raw))tokens.push({type:'integer',value:Number(raw)});
      else tokens.push({type:'token',value:raw});
    }
    let at=0;const peek=()=>tokens[at]?.value,lower=()=>typeof peek()==='string'?peek().toLowerCase():peek();
    const take=v=>{const t=tokens[at++];if(!t||(v&&String(t.value).toLowerCase()!==v))throw Error('syntax');return t;};
    const precedence={or:1,and:2,'=':3,'<>':3,'>':3,'>=':3,'<':3,'<=':3,is:3,in:3};
    function list(open,close){take(open);const values=[expr()];while(peek()===','){take(',');values.push(expr());}take(close);return values;}
    function primary(){
      const t=take();let n;
      if(t.value==='('){n=expr();take(')');}
      else if(t.type==='text'||t.type==='integer'||t.type==='column')n=[t.type,t.value];
      else if(t.value.toLowerCase()==='_utf8mb4'){const s=take();if(s.type!=='text')throw Error('charset');n=['text',s.value];}
      else if(t.value.toLowerCase()==='array')n=['array',list('[',']')];
      else if(['true','false'].includes(t.value.toLowerCase()))n=['boolean',t.value.toLowerCase()];
      else if(/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(t.value))n=['column',t.value];
      else throw Error('operand');
      while(peek()==='::'){
        take('::');let type=take().value.toLowerCase();if(type==='character'){take('varying');type='varchar';}
        const array=peek()==='[';if(array){take('[');take(']');}
        if(array){if(!['text','varchar'].includes(type)||n[0]!=='array'||!n[1].every(x=>x[0]==='text'))throw Error('array cast');}
        else if(['text','varchar'].includes(type)){if(!['text','column'].includes(n[0]))throw Error('text cast');}
        else if(['integer','bigint'].includes(type)){if(n[0]==='text'&&/^\d+$/.test(n[1]))n=['integer',Number(n[1])];else if(n[0]!=='integer')throw Error('integer cast');}
        else throw Error('cast');
      }
      return n;
    }
    function expr(min=0){
      let n=primary();while((precedence[lower()]??-1)>=min){
        const op=take().value.toLowerCase();
        if(op==='in')n=['in',n,list('(',')')];
        else if(op==='is'){const negate=lower()==='not';if(negate)take('not');take('null');n=['null',n,negate];}
        else if(op==='='&&lower()==='any'){take('any');take('(');const arr=primary();take(')');if(arr[0]!=='array')throw Error('ANY');n=['in',n,arr[1]];}
        else n=[op,n,expr(precedence[op]+1)];
      }return n;
    }
    function canon(n){
      if(['column','text','integer','boolean'].includes(n[0]))return n;
      if(n[0]==='null')return ['null',canon(n[1]),n[2]];
      if(n[0]==='in')return ['in',canon(n[1]),n[2].map(canon).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))];
      let children=n.slice(1).map(canon);if(['and','or'].includes(n[0]))children=children.flatMap(c=>c[0]===n[0]?c.slice(1):[c]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return [n[0],...children];
    }
    if(lower()==='check')take('check');const tree=expr();if(at!==tokens.length)throw Error('trailing');return JSON.stringify(canon(tree));
  }catch{return null;}
}
module.exports={normalize};
