export const RESEARCH_METHODS=Object.freeze(['waterfall','clawrec','i2agent','generic-agent','fixed-retrieval']);
// shortcut: BGE is paused online until a host passes memory and latency checks.
export const ONLINE_METHODS=Object.freeze(RESEARCH_METHODS.filter(id=>id!=='fixed-retrieval'));
export function validResearchMethods(ids){
 return Array.isArray(ids)&&ids.length>=2&&ids.length<=RESEARCH_METHODS.length&&new Set(ids).size===ids.length&&ids.includes('waterfall')&&ids.every(id=>RESEARCH_METHODS.includes(id));
}
export function sameResearchMethods(ids,expected){return validResearchMethods(ids)&&validResearchMethods(expected)&&ids.length===expected.length&&ids.every(id=>expected.includes(id));}
