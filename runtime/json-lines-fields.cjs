'use strict';
const { StringDecoder } = require('node:string_decoder');

// Select protocol fields while skipping unrelated Native body strings/trees.
// `true` retains a value; `present` retains only presence; objects select keys.
function selectJsonLines(fields, receive, invalid = () => {}) {
  const decoder = new StringDecoder('utf8');
  let frames, token, root, complete, broken;
  const reset = () => { frames = []; token = null; root = null; complete = false; broken = false; };
  reset();
  const fail = () => { broken = true; token = null; frames = []; invalid(); };
  function selection() {
    const parent = frames.at(-1);
    if (!parent) return complete ? undefined : fields;
    if (!['value', 'firstValue'].includes(parent.expect)) throw Error('value');
    return parent.all ? true : parent.selector?.[parent.key];
  }
  function attach(value, selected) {
    const parent = frames.at(-1);
    if (!parent) { root = value; complete = true; return; }
    if (selected) {
      if (parent.kind === 'array') parent.value.push(value);
      else Object.defineProperty(parent.value, parent.key, { value, enumerable: true, writable: true, configurable: true });
    }
    parent.expect = 'separator';
  }
  function begin(character) {
    const selected = selection();
    if (selected === 'present') attach(true, true);
    if (character === '{' || character === '[') {
      const kind = character === '{' ? 'object' : 'array';
      frames.push({ kind, all: selected === true, selector: selected && typeof selected === 'object' ? selected : null,
        selected: selected === true || !!selected && typeof selected === 'object',
        value: kind === 'object' ? {} : [], key: null, expect: kind === 'object' ? 'firstKey' : 'firstValue' });
      return;
    }
    token = { string: character === '"', escaped: false, unicode:0, key: false, selected: selected === true,
      raw: selected === true || character !== '"' ? character : null, numberState: null };
    if (!token.string && !/[tfn\-0-9]/u.test(character)) throw Error('token');
  }
  function endToken() {
    const value = token;
    token = null;
    if (value.key) {
      const parent = frames.at(-1);
      parent.key = value.raw === null ? null : JSON.parse(value.raw);
      parent.expect = 'colon';
    } else {
      // Bare tokens are small protocol literals/numbers in selected fields.
      // Unselected numbers use only grammar state, never a body-sized buffer.
      let decoded;
      if (value.raw !== null) decoded = JSON.parse(value.raw);
      else if (!value.string && !['zero', 'integer', 'fraction', 'exponentDigits'].includes(value.numberState)) throw Error('number');
      attach(decoded, value.selected);
    }
  }
  function number(character) {
    const state = token.numberState;
    if (state === null) token.numberState = character === '-' ? 'sign' : character === '0' ? 'zero' : 'integer';
    else if ((state === 'sign' || state === 'integer') && /[0-9]/u.test(character)) token.numberState = state === 'sign' && character === '0' ? 'zero' : 'integer';
    else if (['zero', 'integer'].includes(state) && character === '.') token.numberState = 'dot';
    else if (['dot', 'fraction'].includes(state) && /[0-9]/u.test(character)) token.numberState = 'fraction';
    else if (['zero', 'integer', 'fraction'].includes(state) && /[eE]/u.test(character)) token.numberState = 'exponent';
    else if (state === 'exponent' && /[+\-]/u.test(character)) token.numberState = 'exponentSign';
    else if (['exponent', 'exponentSign', 'exponentDigits'].includes(state) && /[0-9]/u.test(character)) token.numberState = 'exponentDigits';
    else throw Error('number');
  }
  function character(character) {
    if (token) {
      if (token.string) {
        if (token.raw !== null) {
          token.raw += character;
          if (token.key && token.keyLimit !== null && token.raw.length > token.keyLimit) token.raw = null;
        }
        if(token.unicode){if(!/[0-9a-fA-F]/u.test(character))throw Error('escape');token.unicode--;}
        else if (token.escaped) {if(!/["\\/bfnrtu]/u.test(character))throw Error('escape');token.escaped=false;if(character==='u')token.unicode=4;}
        else if (character === '\\') token.escaped = true;
        else if (character === '"') endToken();
        else if(character.charCodeAt(0)<32)throw Error('string');
        return;
      }
      if (!/[\s,\]}]/u.test(character)) {
        if (token.numeric) number(character);
        if(token.literal){if(character!==token.literal[token.raw.length])throw Error('literal');}
        if (token.raw !== null) token.raw += character;
        return;
      }
      endToken();
    }
    if (/\s/u.test(character)) return;
    const parent = frames.at(-1);
    if (character === '}' || character === ']') {
      if (!parent || parent.kind !== (character === '}' ? 'object' : 'array') || !['separator', 'firstKey', 'firstValue'].includes(parent.expect)) throw Error('close');
      frames.pop(); attach(parent.value, parent.selected); return;
    }
    if (parent?.expect === 'separator') {
      if (character !== ',') throw Error('separator');
      parent.expect = parent.kind === 'object' ? 'key' : 'value'; return;
    }
    if (parent?.expect === 'colon') {
      if (character !== ':') throw Error('colon'); parent.expect = 'value'; return;
    }
    if (parent && ['key', 'firstKey'].includes(parent.expect)) {
      if (character !== '"') throw Error('key');
      const keys = Object.keys(parent.selector ?? {});
      // A matching JSON key has at most six source characters per key character
      // (a \uXXXX escape). Longer unrelated keys cannot match this vocabulary.
      const keyLimit = parent.all ? null : Math.max(0, ...keys.map(key => key.length)) * 6 + 2;
      token = { string: true, escaped: false, unicode:0, key: true, keyLimit, raw: '"' }; return;
    }
    begin(character);
    if (token && !token.string) {
      token.numeric = /[\-0-9]/u.test(character);
      token.literal=({t:'true',f:'false',n:'null'})[character];
      if (token.numeric) { number(character); if (!token.selected) token.raw = null; }
    }
  }
  function write(input) {
    const text = typeof input === 'string' ? input : decoder.write(input);
    for (const value of text) {
      if (value === '\n') {
        if (!broken) {
          try { if (token && !token.string) endToken(); if (!frames.length && !token && !complete) { reset(); continue; } if (frames.length || token || !complete) throw Error('line'); receive(root); }
          catch { invalid(); }
        }
        reset(); continue;
      }
      if (!broken) try { character(value); } catch { fail(); }
    }
  }
  return Object.freeze({ write, reset });
}
module.exports = { selectJsonLines };
