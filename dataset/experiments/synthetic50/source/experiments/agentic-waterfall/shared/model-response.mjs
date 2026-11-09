export async function readModelResponse(response) {
  if(!response.headers?.get?.('content-type')?.includes('text/event-stream'))return response.json();
  const result={choices:[{message:{content:'',reasoning_content:''},finish_reason:null}],usage:null};
  const decoder=new TextDecoder();let buffer='',done=false,events=0,firstEventAt=null;
  const consume=frame=>{
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data.trim()==='[DONE]'){done=true;return;}
    const chunk=JSON.parse(data);events++;firstEventAt??=new Date().toISOString();
    if(chunk.error)throw Object.assign(Error('model_transport_error'),{streamError:chunk.error});
    if(chunk.model)result.model=chunk.model;
    if(chunk.usage)result.usage=chunk.usage;
    const choice=chunk.choices?.find(c=>c.index===0||c.index===undefined);
    if(choice){
      for(const field of ['content','reasoning_content'])if(typeof choice.delta?.[field]==='string')result.choices[0].message[field]+=choice.delta[field];
      if(choice.finish_reason)result.choices[0].finish_reason=choice.finish_reason;
    }
  };
  try {
    for await(const bytes of response.body){
      buffer=(buffer+decoder.decode(bytes,{stream:true})).replace(/\r\n/g,'\n');
      let end;while((end=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+2);}
      if(done)break;
    }
    buffer+=decoder.decode();if(buffer.trim())consume(buffer.replace(/\r\n/g,'\n'));
    if(!done||!result.choices[0].finish_reason)throw Error('model_stream_incomplete');
    result.stream_metadata={received:true,events,first_event_at:firstEventAt,complete:true};return result;
  } catch(error){
    throw Object.assign(Error('model_transport_error'),{partialResponse:result,streamError:error.streamError,streamDiagnostic:{reason:error.message,events,first_event_at:firstEventAt,complete:false}});
  }
}
