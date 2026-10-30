export const nativePublisherScript=`var Dispatcher,stream;
function initializeNativePublisher(){
  Dispatcher=class NativeDispatcher{
    static instance=null;
    static getInstance(){return this.instance??=new NativeDispatcher;}
    handlers=new Map;hostMessageInterceptors=new Set;
    initialized=true;isListeningToWindow=true;windowMessageListener=()=>{};
    constructor(){this.dispatchMessage=this.dispatchMessage.bind(this);}
    dispatchMessage(type,payload){postbox.postMessage({...payload,type});}
    deliverMessage(type,message){for(const listener of this.handlers.get(type)??[])listener(message);}
    subscribe(type,listener){const handlers=this.handlers.get(type)??new Set;handlers.add(listener);this.handlers.set(type,handlers);return()=>{handlers.delete(listener);if(!handlers.size)this.handlers.delete(type);};}
  };
  stream=Dispatcher.getInstance();
}`;
export const nativePublisherSource=nativePublisherScript+'export{Dispatcher as NativeBus,stream as PublishedMessages,postbox as Transport};';
export function publishedFixture(){
  const postbox={postMessage(){}};
  const namespace=Function('postbox',nativePublisherScript+'initializeNativePublisher();return{NativeBus:Dispatcher,PublishedMessages:stream,Transport:postbox};')(postbox);
  return{namespace,postbox,bus:namespace.PublishedMessages};
}
