import mark from '../../assets/codlet/svg/codlet-currentcolor.svg';
import smallMark from '../../assets/codlet/svg/codlet-small.svg';

// Both marks retain the approved contours. The sidebar omits the eye and uses
// slightly less surrounding whitespace to match native 16 px icons.
export function createCodletIcon(React,{compact=false}={}) {
  const source=compact?smallMark:mark,body=source.slice(source.indexOf('<g '),source.lastIndexOf('</svg>'));
  return function CodletIcon({size=24,width=size,height=size,...props}) {
    return React.createElement('svg', {viewBox:compact?'32 32 960 960':'0 0 1024 1024',width,height,
      fill:'currentColor','aria-hidden':true,focusable:false,...props,
      dangerouslySetInnerHTML:{__html:body}});
  };
}
