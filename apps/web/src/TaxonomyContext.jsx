import React, {createContext,useCallback,useContext,useEffect,useMemo,useState} from 'react';
import {api} from './api.js';
import {Notice} from './ui.jsx';
import {createTaxonomyContext,getCategory,categoryMatches} from '../../../packages/catalog/taxonomy.js';
const Context=createContext(null);
export function TaxonomyProvider({children}) {
  const [data,setData]=useState(null),[error,setError]=useState('');
  const reload=useCallback(async()=>{try{const result=await api('/api/taxonomy');setData(result);setError('');return result;}catch(e){setError(e.message);throw e;}},[]);
  useEffect(()=>{reload().catch(()=>{});},[reload]);
  const value=useMemo(()=>{if(!data)return null;const context=createTaxonomyContext(data);return {...context,reload,getCategory:id=>getCategory(id,context),matches:(id,parent)=>categoryMatches(id,parent,context)};},[data,reload]);
  if(!value)return <main className="taxonomy-loading">{error?<><Notice>Не вдалося завантажити категорії: {error}</Notice><button className="button secondary" onClick={()=>reload().catch(()=>{})}>Повторити завантаження категорій</button></>:<p role="status">Завантажуємо категорії…</p>}</main>;
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useTaxonomy(){const value=useContext(Context);if(!value)throw new Error('TaxonomyProvider is required');return value;}
