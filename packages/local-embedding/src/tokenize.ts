import {Tokenizer} from '@huggingface/tokenizers'

export type TextTokenizer={encode(text:string):{ids:number[];truncated:boolean}}

/**
 * 与 HF `tokenizers` 的 `enable_truncation(maxTokens)` 等价：截断发生在后处理之前，并为后处理器追加的
 * `<|endoftext|>` 预留一位，因此池化位（最后一个有效词元）永远是追加位。`@huggingface/tokenizers` 没有截断选项，
 * 这里先不加特殊词元编码、截断到 maxTokens-1，再补追加位；构造时核对后处理器确实只在末尾追加 appendedTokenId。
 */
export function createTextTokenizer(tokenizerJson:object,tokenizerConfig:object,options:{maxTokens:number;appendedTokenId:number}):TextTokenizer{
 const tokenizer=new Tokenizer(tokenizerJson,tokenizerConfig)
 const probe=tokenizer.encode('').ids
 if(probe.length!==1||probe[0]!==options.appendedTokenId)throw new Error('分词器后处理器与固定配置不一致。')
 const keep=options.maxTokens-1
 return {encode(text){
  const ids=tokenizer.encode(text,{add_special_tokens:false}).ids
  const truncated=ids.length>keep
  return {ids:[...(truncated?ids.slice(0,keep):ids),options.appendedTokenId],truncated}
 }}
}
