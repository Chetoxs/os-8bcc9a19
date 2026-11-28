const e=new Map;function t(a,n){return!!(n!=null&&n.name)&&(Number(n.n)||0)>(e.get(a)||0)}function o(a,n){n!=null&&n.n&&e.set(a,Math.max(e.get(a)||0,Number(n.n)))}export{o as a,t as n};
