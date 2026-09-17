const APP_PATCH_VERSION='2.1.11-argenmap50-etiquetas80';
import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.1.0/dist/maplibre-gl.mjs';

const COLORS = {
  'Térmica': '#d74c3f',
  'Hidráulica': '#2f78b7',
  'Nuclear': '#7656a5',
  'Eólica': '#4c9b68',
  'Solar': '#e9a72e',
  'Biomasa': '#857142',
  'Biogás': '#39a1a6',
  'Otra': '#7c8790'
};
const TYPE_ORDER = ['Térmica','Hidráulica','Nuclear','Eólica','Solar','Biomasa','Biogás','Otra'];
const QUALITY_ORDER = ['CONFIRMADA','ALTA','MEDIA','PROVISORIA','REVISAR','CONFLICTO'];
const QUALITY_LABEL = {
  CONFIRMADA:'Confirmada', ALTA:'Alta', MEDIA:'Media',
  PROVISORIA:'Provisoria / aproximada', REVISAR:'Provisoria a revisar', CONFLICTO:'Conflicto entre fuentes'
};

const state = {
  config: null,
  catalog: null,
  geo: {type:'FeatureCollection',features:[]},
  map: null,
  baseLayers: new Map(),
  external: new Map(),
  currentFiltered: [],
  currentBasemap: null,
  preferences: {},
  statusItems: []
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (x) => String(x ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = (n,d=0) => Number.isFinite(Number(n)) ? Number(n).toLocaleString('es-AR',{maximumFractionDigits:d}) : 's/d';
const yes = (v) => ['SI','SÍ','TRUE','1','YES'].includes(String(v ?? '').trim().toUpperCase());

async function loadJson(path, fallback=null) {
  try {
    const r = await fetch(path,{cache:'no-store'});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (String(path).toLowerCase().endsWith('.geojsonz')) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('El navegador no soporta descompresión GZIP mediante DecompressionStream');
      }
      const ds = new DecompressionStream('gzip');
      const decompressed = r.body.pipeThrough(ds);
      const txt = await new Response(decompressed).text();
      return JSON.parse(txt);
    }
    return await r.json();
  } catch (e) {
    if (fallback !== null) return fallback;
    throw new Error(`${path}: ${e.message}`);
  }
}

function loadPreferences() {
  try { state.preferences = JSON.parse(localStorage.getItem('geoelectrico_2_1_preferences') || '{}'); }
  catch { state.preferences = {}; }
}
function savePreferences() {
  localStorage.setItem('geoelectrico_2_1_preferences', JSON.stringify(state.preferences));
}


function applyPreferenceMigrations() {
  const targetVersion='2.1.11-argenmap50-etiquetas80';
  if(state.preferences?.schemaVersion===targetVersion) return;

  state.preferences.layers ||= {};
  state.preferences.layerOpacity ||= {};
  state.preferences.classLayers ||= {};
  state.preferences.basemapOpacity ||= {};

  // Concesiones: conservar inicio desactivado tras la actualización.
  (state.catalog?.capas||[])
    .filter(l=>String(l.ID_RECURSO_ORIGEN||'')==='SE_CONCESIONES_DIST_SRC')
    .forEach(l=>{
      delete state.preferences.layers[l.ID_CAPA];
      delete state.preferences.layerOpacity[l.ID_CAPA];
    });

  // EE.TT. local activa; WMS apagada.
  state.preferences.layers['SE_EETT_WMS']=false;
  (state.catalog?.capas||[]).forEach(l=>{
    const rid=String(l.ID_RECURSO_ORIGEN||'');
    if(rid==='SE_AT_EETT_SRC'){
      state.preferences.layers[l.ID_CAPA]=true;
      delete state.preferences.layerOpacity[l.ID_CAPA];
    }
  });

  // Nuevo estado inicial solicitado: Argenmap clásico al 50%.
  // Se aplica una sola vez en esta migración; luego el usuario puede cambiar
  // mapa/opacidad y la preferencia vuelve a persistir normalmente.
  state.preferences.basemap='argenmap';
  state.preferences.basemapOpacity['argenmap']=0.50;

  state.preferences.schemaVersion=targetVersion;
  savePreferences();
}

function addStatus(text, kind='info') {
  const item = {text,kind,ts:new Date().toLocaleTimeString('es-AR')};
  state.statusItems.unshift(item);
  state.statusItems = state.statusItems.slice(0,10);
  const box = $('#service-status');
  if (box) box.innerHTML = state.statusItems.map(x=>`<div class="status-item ${x.kind}"><span>${esc(x.ts)}</span>${esc(x.text)}</div>`).join('');
}

function baseStyle() {
  return {version:8, sources:{}, layers:[{id:'background',type:'background',paint:{'background-color':'#ffffff'}}]};
}

function normalizeUrlTemplate(url) {
  return String(url || '').trim();
}

function availableBasemaps() {
  return (state.catalog?.mapas_base || []).filter(x=>yes(x.ACTIVO) && yes(x.PUBLICAR));
}

function basemapIsAvailable(bm) {
  if (!yes(bm.REQUIERE_TOKEN)) return true;
  return Boolean((state.config?.esri_token || '').trim());
}

function addBasemapSourcesAndLayers() {
  const map = state.map;
  availableBasemaps().forEach((bm,index)=>{
    const id = bm.ID_MAPA_BASE;
    const tipo = String(bm.TIPO || '').toUpperCase();
    if (tipo === 'BLANCO') {
      state.baseLayers.set(id,{id,layerIds:[],type:'white',config:bm});
      return;
    }
    let url = normalizeUrlTemplate(bm.URL_TEMPLATE);
    if (yes(bm.REQUIERE_TOKEN)) {
      const token = (state.config.esri_token || '').trim();
      url = url.replace('{ESRI_TOKEN}', encodeURIComponent(token));
    }
    const sourceId = `base-src-${id}`;
    const layerId = `base-${id}`;
    const source = {
      type:'raster', tiles:[url], tileSize:Number(bm.TILE_SIZE || 256),
      minzoom:Number(bm.MINZOOM || 0), maxzoom:Number(bm.MAXZOOM || 22),
      attribution:bm.ATRIBUCION || ''
    };
    if (String(bm.SCHEME || '').toLowerCase() === 'tms') source.scheme = 'tms';
    map.addSource(sourceId,source);
    map.addLayer({
      id:layerId,type:'raster',source:sourceId,layout:{visibility:'none'},
      paint:{'raster-opacity':Number(bm.OPACIDAD_INICIAL ?? 1)}
    }, firstOverlayLayerId());
    state.baseLayers.set(id,{id,sourceId,layerIds:[layerId],type:'raster',config:bm});
  });
}

function firstOverlayLayerId() {
  const layers = state.map?.getStyle()?.layers || [];
  const found = layers.find(l => l.id === 'centrales');
  return found?.id;
}

function setBasemap(id, persist=true) {
  const bm = availableBasemaps().find(x=>x.ID_MAPA_BASE===id);
  if (!bm) return;
  if (!basemapIsAvailable(bm)) {
    addStatus(`${bm.TITULO}: requiere token/API key configurado.`, 'warn');
    return;
  }
  state.currentBasemap = id;
  state.baseLayers.forEach((entry,key)=>{
    entry.layerIds.forEach(layerId=>{
      if (state.map.getLayer(layerId)) state.map.setLayoutProperty(layerId,'visibility',key===id?'visible':'none');
    });
  });
  const opacity = Number(state.preferences.basemapOpacity?.[id] ?? bm.OPACIDAD_INICIAL ?? 1);
  setBasemapOpacity(opacity,false);
  $('#basemap-opacity').value = Math.round(opacity*100);
  $('#basemap-opacity-value').textContent = `${Math.round(opacity*100)} %`;
  if (persist) {
    state.preferences.basemap = id;
    savePreferences();
  }
}

function setBasemapOpacity(opacity, persist=true) {
  opacity = Math.max(0,Math.min(1,Number(opacity)));
  const entry = state.baseLayers.get(state.currentBasemap);
  if (entry?.type==='raster') {
    entry.layerIds.forEach(layerId=>state.map.getLayer(layerId) && state.map.setPaintProperty(layerId,'raster-opacity',opacity));
  }
  if (persist && state.currentBasemap) {
    state.preferences.basemapOpacity ||= {};
    state.preferences.basemapOpacity[state.currentBasemap] = opacity;
    savePreferences();
  }
}

function buildBasemapUi() {
  const select = $('#basemap-select');
  select.innerHTML = availableBasemaps().map(bm=>{
    const disabled = !basemapIsAvailable(bm);
    const suffix = disabled ? ' (requiere token)' : '';
    return `<option value="${esc(bm.ID_MAPA_BASE)}" ${disabled?'disabled':''}>${esc(bm.TITULO + suffix)}</option>`;
  }).join('');
  const desired = state.preferences.basemap || state.config.initial_basemap || availableBasemaps()[0]?.ID_MAPA_BASE;
  const target = availableBasemaps().find(x=>x.ID_MAPA_BASE===desired && basemapIsAvailable(x)) || availableBasemaps().find(basemapIsAvailable);
  if (target) {
    select.value = target.ID_MAPA_BASE;
    setBasemap(target.ID_MAPA_BASE,false);
  }
  select.addEventListener('change',()=>setBasemap(select.value));
  $('#basemap-opacity').addEventListener('input',(e)=>{
    const v=Number(e.target.value)/100;
    $('#basemap-opacity-value').textContent=`${e.target.value} %`;
    setBasemapOpacity(v);
  });
  $('#reset-preferences').addEventListener('click',()=>{
    localStorage.removeItem('geoelectrico_2_1_preferences');
    location.reload();
  });
}

function buildWmsTileUrl(layer) {
  const base = String(layer.URL_BASE || '').trim();
  const sep = base.includes('?') ? (base.endsWith('?')||base.endsWith('&')?'':'&') : '?';
  const version = layer.VERSION || '1.1.1';
  const params = new URLSearchParams({
    service:'WMS', request:'GetMap', version,
    layers:layer.NOMBRE_OGC, styles:layer.WMS_STYLE || '',
    format:layer.WMS_FORMAT || 'image/png', transparent:String(layer.WMS_TRANSPARENT || 'true').toLowerCase(),
    width:'256', height:'256'
  });
  if (version.startsWith('1.3')) params.set('crs',layer.CRS_PREFERIDO || 'EPSG:3857');
  else params.set('srs',layer.CRS_PREFERIDO || 'EPSG:3857');
  return `${base}${sep}${params.toString()}&bbox={bbox-epsg-3857}`;
}

function buildWfsUrl(layer, outputFormat=null) {
  const base = String(layer.URL_BASE || '').trim();
  const sep = base.includes('?') ? (base.endsWith('?')||base.endsWith('&')?'':'&') : '?';
  const params = new URLSearchParams({
    service:'WFS', request:'GetFeature', version:layer.VERSION || '1.1.0',
    typeName:layer.NOMBRE_OGC,
    srsName:layer.WFS_SRSNAME || 'EPSG:4326',
    outputFormat:outputFormat || layer.WFS_OUTPUTFORMAT || 'application/json'
  });
  if (layer.WFS_MAXFEATURES) params.set('maxFeatures',layer.WFS_MAXFEATURES);
  if (layer.WFS_FILTER) params.set('CQL_FILTER',layer.WFS_FILTER);
  return `${base}${sep}${params.toString()}`;
}

function clamp01(v){ return Math.max(0,Math.min(1,Number(v))); }

function polygonFillMax(layer){
  const id=String(layer?.ID_CAPA||'').toUpperCase();

  // Las demarcaciones IGN WFS son capas de límites. Nunca deben cubrir
  // el mapa base con un relleno, aunque exista una preferencia antigua
  // o el catálogo no traiga OPACIDAD_RELLENO.
  if(id==='IGN_PROVINCIAS_WFS' || id==='IGN_DEPARTAMENTOS_WFS') return 0;

  const raw=layer?.OPACIDAD_RELLENO;
  if(raw===null || raw===undefined || raw==='') return 0.12;

  const explicit=Number(raw);
  if(Number.isFinite(explicit)) return clamp01(explicit);
  return 0.12;
}

function polygonFillOpacity(layer, layerOpacity){
  return clamp01(layerOpacity) * polygonFillMax(layer);
}

function externalPaint(layer, geom, override={}) {
  const color = override.color || layer.COLOR || '#2563eb';
  const opacity = clamp01(layer.OPACIDAD_INICIAL ?? 0.75);
  if (geom==='LINEA') return {'line-color':color,'line-width':Number(override.grosor ?? layer.GROSOR ?? 2.2),'line-opacity':opacity};
  if (geom==='PUNTO') return {'circle-color':color,'circle-radius':Number(override.tamano ?? layer.TAMANO ?? 5),'circle-opacity':opacity,'circle-stroke-color':'#ffffff','circle-stroke-width':0.8};
  return {'fill-color':color,'fill-opacity':polygonFillOpacity(layer,opacity),'fill-outline-color':'rgba(0,0,0,0)'};
}

function addWmsLayer(layer) {
  const id = layer.ID_CAPA;
  if (state.external.has(id)) return state.external.get(id);
  const sourceId=`ext-src-${id}`, layerId=`ext-${id}`;
  state.map.addSource(sourceId,{
    type:'raster',tiles:[buildWmsTileUrl(layer)],tileSize:256,
    minzoom:Number(layer.ZOOM_MIN||0),maxzoom:Number(layer.ZOOM_MAX||22),
    attribution:layer.ATRIBUCION || layer.ORGANISMO_NOMBRE || ''
  });
  state.map.addLayer({id:layerId,type:'raster',source:sourceId,layout:{visibility:'none'},paint:{'raster-opacity':Number(layer.OPACIDAD_INICIAL??0.8)}},'centrales');
  const entry={layer,sourceId,layerIds:[layerId],loaded:true,loading:false,error:null};
  state.external.set(id,entry);
  return entry;
}

async function fetchWfsGeoJson(layer) {
  const formats = [...new Set([layer.WFS_OUTPUTFORMAT,'application/json','json','geojson'].filter(Boolean))];
  let lastError=null;
  for (const format of formats) {
    const url=buildWfsUrl(layer,format);
    try {
      const r=await fetch(url,{mode:'cors'});
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct=r.headers.get('content-type')||'';
      const text=await r.text();
      if (ct.includes('json') || text.trim().startsWith('{')) {
        const obj=JSON.parse(text);
        if (obj.type==='FeatureCollection') return obj;
      }
      throw new Error(`respuesta no GeoJSON (${ct || 'sin content-type'})`);
    } catch(e) { lastError=e; }
  }
  throw lastError || new Error('WFS sin formato GeoJSON utilizable');
}

function geometryKindFromGeoJson(geo, fallback='LINEA') {
  const t=geo?.features?.find(f=>f.geometry)?.geometry?.type || '';
  if (t.includes('Point')) return 'PUNTO';
  if (t.includes('Line')) return 'LINEA';
  if (t.includes('Polygon')) return 'POLIGONO';
  return String(fallback||'LINEA').toUpperCase();
}


function classificationKey(v){ return String(v ?? '').replace(/[^A-Za-z0-9_-]+/g,'_').slice(0,50) || 'valor'; }
function classPreferenceId(layer,value){ return `${layer.ID_CAPA}::${String(value)}`; }
function isLocalVector(layer){ return ['GEOJSON_LOCAL','VECTOR_LOCAL'].includes(String(layer.PROTOCOLO||'').toUpperCase()) || String(layer.PROTOCOLO_PREFERIDO||'').toUpperCase()==='VECTOR_LOCAL'; }

function registerExternalFeatureEvents(layer, layerIds){
  layerIds.forEach(lid=>{
    state.map.on('mouseenter',lid,()=>state.map.getCanvas().style.cursor='pointer');
    state.map.on('mouseleave',lid,()=>state.map.getCanvas().style.cursor='');
    state.map.on('click',lid,(e)=>renderExternalDetails(layer,e.features?.[0]?.properties||{}));
  });
}


function normalizeHexColor(c){
  const s=String(c||'#7C3AED').trim();
  if(/^#[0-9a-f]{6}$/i.test(s)) return s.toUpperCase();
  if(/^#[0-9a-f]{3}$/i.test(s)) return '#'+s.slice(1).split('').map(x=>x+x).join('').toUpperCase();
  return '#7C3AED';
}
function hexRgb(c){
  const h=normalizeHexColor(c).slice(1);
  return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
}
function mixWhite(c,ratio=0.82){
  const [r,g,b]=hexRgb(c);
  const m=x=>Math.round(x+(255-x)*ratio);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
function squareIconName(color){ return `geo21-square-${normalizeHexColor(color).slice(1).toLowerCase()}`; }
function ensureSquareIcon(color){
  const name=squareIconName(color);
  if(state.map.hasImage(name)) return name;
  const size=28;
  const canvas=document.createElement('canvas');
  canvas.width=size; canvas.height=size;
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle=mixWhite(color,0.82);
  ctx.fillRect(4,4,size-8,size-8);
  ctx.strokeStyle=normalizeHexColor(color);
  ctx.lineWidth=4;
  ctx.strokeRect(4,4,size-8,size-8);
  state.map.addImage(name,ctx.getImageData(0,0,size,size),{pixelRatio:2});
  return name;
}
function useSquareSymbol(layer){ return String(layer.SIMBOLO||'').toUpperCase()==='CUADRADO'; }


function voltageLabelText(style){
  const raw=style?.valor;
  const label=String(style?.etiqueta||'').trim();
  if(raw===null || raw===undefined || raw==='' || /sin dato/i.test(label)) return null;
  const n=Number(raw);
  if(Number.isFinite(n)) return `${Number.isInteger(n)?n:n.toLocaleString('es-AR')} kV`;
  const m=label.match(/(\d+(?:[.,]\d+)?)\s*kV/i);
  return m ? `${m[1]} kV` : null;
}

function colorLuminance(hex){
  const [r,g,b]=hexRgb(hex).map(v=>v/255);
  const cv=v=>v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);
  return 0.2126*cv(r)+0.7152*cv(g)+0.0722*cv(b);
}

function labelTextColor(){
  // Estilo único para todas las etiquetas de Líneas AT:
  // interior oscuro y contorno blanco, como la referencia de 66 kV.
  return '#123A56';
}

function labelHaloColor(){
  return 'rgba(255,255,255,0.98)';
}

function voltageLabelIconName(text,color){
  return `geo21-voltage-${String(text).replace(/[^0-9a-z]+/gi,'-').toLowerCase()}-${normalizeHexColor(color).slice(1).toLowerCase()}`;
}

function ensureVoltageLabelIcon(text,color){
  const name=voltageLabelIconName(text,color);
  if(state.map.hasImage(name)) return name;

  const scale=2;
  const fontPx=10.4;
  const font=`700 ${fontPx}px Arial`;
  const tmp=document.createElement('canvas');
  const tctx=tmp.getContext('2d');
  tctx.font=font;
  const width=Math.ceil(tctx.measureText(text).width)+8;
  const height=20;

  const canvas=document.createElement('canvas');
  canvas.width=width*scale;
  canvas.height=height*scale;
  const ctx=canvas.getContext('2d');
  ctx.scale(scale,scale);
  ctx.font=font;
  ctx.textAlign='center';
  ctx.textBaseline='middle';
  ctx.lineJoin='round';
  ctx.lineCap='round';

  const x=width/2, y=height/2;
  // Sin caja de fondo: sólo texto oscuro con halo/contorno blanco.
  ctx.strokeStyle=labelHaloColor();
  ctx.lineWidth=2.4;
  ctx.strokeText(text,x,y);
  ctx.fillStyle=labelTextColor();
  ctx.fillText(text,x,y);

  state.map.addImage(name,ctx.getImageData(0,0,canvas.width,canvas.height),{pixelRatio:scale});
  return name;
}

function isTransmissionLineLocal(layer){
  return String(layer?.ID_RECURSO_ORIGEN||'')==='SE_AT_LINEAS_SRC';
}



function addGeoJsonRenderedLayers(layer, entry, data){
  const geom=geometryKindFromGeoJson(data,layer.TIPO_GEOMETRIA);
  const classes=Array.isArray(layer.CLASIFICACIONES)?layer.CLASIFICACIONES:[];
  const field=layer.CAMPO_CLASIFICACION;
  entry.classLayerIds={};
  entry.labelLayerIds ||= [];
  const addOne=(suffix,filter,style={})=>{
    const ids=[];
    if(geom==='POLIGONO'){
      const fillId=`ext-${layer.ID_CAPA}-${suffix}-fill`, lineId=`ext-${layer.ID_CAPA}-${suffix}-line`;
      const fillDef={id:fillId,type:'fill',source:entry.sourceId,layout:{visibility:'none'},paint:externalPaint(layer,'POLIGONO',style)};
      const lineDef={id:lineId,type:'line',source:entry.sourceId,layout:{visibility:'none'},paint:{'line-color':style.color||layer.COLOR||'#2563eb','line-width':Number(style.grosor??layer.GROSOR??1.2),'line-opacity':Number(layer.OPACIDAD_INICIAL??0.75)}};
      if(filter){fillDef.filter=filter;lineDef.filter=filter;}
      state.map.addLayer(fillDef,'centrales'); state.map.addLayer(lineDef,'centrales');
      ids.push(fillId,lineId);
    }else if(geom==='PUNTO'){
      const lid=`ext-${layer.ID_CAPA}-${suffix}`;
      if(useSquareSymbol(layer)){
        const color=style.color||layer.COLOR||'#7C3AED';
        const icon=ensureSquareIcon(color);
        const size=Number(style.tamano??layer.TAMANO??10);
        const def={
          id:lid,type:'symbol',source:entry.sourceId,
          layout:{
            visibility:'none',
            'icon-image':icon,
            'icon-size':Math.max(0.55,Math.min(1.6,size/10)),
            'icon-allow-overlap':true,
            'icon-ignore-placement':true
          },
          paint:{'icon-opacity':Number(layer.OPACIDAD_INICIAL??1)}
        };
        if(filter)def.filter=filter;
        state.map.addLayer(def,'centrales'); ids.push(lid);
      }else{
        const def={id:lid,type:'circle',source:entry.sourceId,layout:{visibility:'none'},paint:externalPaint(layer,'PUNTO',style)};
        if(filter)def.filter=filter; state.map.addLayer(def,'centrales'); ids.push(lid);
      }
    }else{
      const lid=`ext-${layer.ID_CAPA}-${suffix}`;
      const def={id:lid,type:'line',source:entry.sourceId,layout:{visibility:'none'},paint:externalPaint(layer,'LINEA',style)};
      if(filter)def.filter=filter;
      state.map.addLayer(def,'centrales');
      ids.push(lid);

      // Etiqueta de tensión sobre Líneas AT locales.
      // Es un icono transparente que contiene únicamente el texto:
      // no tiene caja/fondo y se orienta siguiendo la línea.
      if(isTransmissionLineLocal(layer)){
        const labelText=voltageLabelText(style);
        if(labelText){
          const color=style.color||layer.COLOR||'#2563EB';
          const labelId=`${lid}-kv-label`;
          const icon=ensureVoltageLabelIcon(labelText,color);
          const labelDef={
            id:labelId,
            type:'symbol',
            source:entry.sourceId,
            minzoom:Math.max(5,Number(layer.ZOOM_MIN??3)),
            layout:{
              visibility:'none',
              'symbol-placement':'line',
              'symbol-spacing':420,
              'icon-image':icon,
              'icon-size':1,
              'icon-rotation-alignment':'map',
              'icon-keep-upright':true,
              'icon-allow-overlap':false,
              'icon-ignore-placement':false,
              'icon-padding':3
            },
            paint:{
              // La etiqueta queda ligeramente más opaca que la línea.
              'icon-opacity':Math.min(1,Number(layer.OPACIDAD_INICIAL??0.9)+0.10)
            }
          };
          if(filter)labelDef.filter=filter;
          state.map.addLayer(labelDef,'centrales');
          ids.push(labelId);
          entry.labelLayerIds.push(labelId);
        }
      }
    }
    entry.layerIds.push(...ids); registerExternalFeatureEvents(layer,ids); return ids;
  };
  if(classes.length && field){
    classes.forEach(c=>{
      const key=String(c.valor); const filter=['==',['to-string',['get',field]],key];
      entry.classLayerIds[key]=addOne(`c-${classificationKey(key)}`,filter,c);
    });
  }else{
    addOne('all',null,{});
  }
  return entry;
}

async function ensureLocalVectorLayer(layer){
  const id=layer.ID_CAPA;
  if(state.external.has(id)&&state.external.get(id).loaded)return state.external.get(id);
  let entry=state.external.get(id)||{layer,sourceId:`ext-src-${id}`,layerIds:[],classLayerIds:{},loaded:false,loading:false,error:null};
  if(entry.loading)return entry;
  entry.loading=true; state.external.set(id,entry); setLayerUiState(id,'loading'); addStatus(`Cargando vector local: ${layer.TITULO}...`,'info');
  try{
    const data=await loadJson(layer.RUTA_LOCAL);
    if(data?.type!=='FeatureCollection')throw new Error('archivo local no es FeatureCollection');
    state.map.addSource(entry.sourceId,{type:'geojson',data});
    entry=addGeoJsonRenderedLayers(layer,entry,data); entry.loaded=true; entry.loading=false; entry.error=null;
    addStatus(`Vector local cargado: ${layer.TITULO} (${fmt(data.features?.length||0)} entidades).`,'ok'); setLayerUiState(id,'ready'); return entry;
  }catch(e){
    entry.loading=false;entry.error=e.message;setLayerUiState(id,'error');addStatus(`Vector local no disponible: ${layer.TITULO}. ${e.message}`,'error');throw e;
  }
}

async function ensureWfsLayer(layer) {
  const id=layer.ID_CAPA;
  if (state.external.has(id) && state.external.get(id).loaded) return state.external.get(id);
  let entry=state.external.get(id) || {layer,sourceId:`ext-src-${id}`,layerIds:[],loaded:false,loading:false,error:null};
  if (entry.loading) return entry;
  entry.loading=true; state.external.set(id,entry);
  setLayerUiState(id,'loading');
  addStatus(`Cargando WFS: ${layer.TITULO}...`,'info');
  try {
    const data=await fetchWfsGeoJson(layer);
    const geom=geometryKindFromGeoJson(data,layer.TIPO_GEOMETRIA);
    state.map.addSource(entry.sourceId,{type:'geojson',data});
    if (geom==='POLIGONO') {
      const fillId=`ext-${id}-fill`, lineId=`ext-${id}-line`;
      const fillPaint=externalPaint(layer,'POLIGONO');
      if(id==='IGN_PROVINCIAS_WFS' || id==='IGN_DEPARTAMENTOS_WFS'){
        fillPaint['fill-opacity']=0;
      }
      state.map.addLayer({id:fillId,type:'fill',source:entry.sourceId,layout:{visibility:'none'},paint:fillPaint},'centrales');
      state.map.addLayer({id:lineId,type:'line',source:entry.sourceId,layout:{visibility:'none'},paint:{'line-color':layer.COLOR||'#2563eb','line-width':Number(layer.GROSOR||1.2),'line-opacity':Number(layer.OPACIDAD_INICIAL??0.75)}},'centrales');
      entry.layerIds=[fillId,lineId];
    } else if (geom==='PUNTO') {
      const lid=`ext-${id}`;
      state.map.addLayer({id:lid,type:'circle',source:entry.sourceId,layout:{visibility:'none'},paint:externalPaint(layer,'PUNTO')},'centrales');
      entry.layerIds=[lid];
    } else {
      const lid=`ext-${id}`;
      state.map.addLayer({id:lid,type:'line',source:entry.sourceId,layout:{visibility:'none'},paint:externalPaint(layer,'LINEA')},'centrales');
      entry.layerIds=[lid];
    }
    entry.loaded=true; entry.loading=false; entry.error=null;
    addStatus(`WFS cargado: ${layer.TITULO} (${fmt(data.features?.length||0)} entidades).`,'ok');
    setLayerUiState(id,'ready');
    return entry;
  } catch(e) {
    entry.loading=false; entry.error=e.message;
    setLayerUiState(id,'error');
    addStatus(`WFS no disponible en navegador: ${layer.TITULO}. ${e.message}. Puede usarse la variante WMS.`, 'error');
    throw e;
  }
}

function setLayerUiState(id,status) {
  const el=document.querySelector(`[data-layer-status="${CSS.escape(id)}"]`);
  if (!el) return;
  const map={loading:'…',ready:'✓',error:'!'};
  el.textContent=map[status]||'';
  el.dataset.state=status;
}

async function toggleExternal(layer,visible,persist=true) {
  try {
    let entry;
    if (isLocalVector(layer)) entry=await ensureLocalVectorLayer(layer);
    else if (String(layer.PROTOCOLO).toUpperCase()==='WFS') entry=await ensureWfsLayer(layer);
    else entry=addWmsLayer(layer);
    const savedOpacity=Number(state.preferences.layerOpacity?.[layer.ID_CAPA] ?? layer.OPACIDAD_INICIAL ?? 0.8);
    setExternalOpacity(layer,savedOpacity,false);
    const classes=Array.isArray(layer.CLASIFICACIONES)?layer.CLASIFICACIONES:[];
    if(classes.length && entry.classLayerIds){
      for(const c of classes){
        const pref=state.preferences.classLayers?.[classPreferenceId(layer,c.valor)];
        const on=visible && (pref===undefined?Boolean(c.visible_inicial):Boolean(pref));
        (entry.classLayerIds[String(c.valor)]||[]).forEach(lid=>state.map.getLayer(lid)&&state.map.setLayoutProperty(lid,'visibility',on?'visible':'none'));
        const cb=document.querySelector(`[data-class-toggle="${CSS.escape(classPreferenceId(layer,c.valor))}"]`); if(cb)cb.checked=on;
      }
    }else entry.layerIds.forEach(lid=>state.map.getLayer(lid)&&state.map.setLayoutProperty(lid,'visibility',visible?'visible':'none'));
    if (persist) { state.preferences.layers ||= {}; state.preferences.layers[layer.ID_CAPA] = visible; savePreferences(); }
  } catch {
    const cb=document.querySelector(`[data-layer-toggle="${CSS.escape(layer.ID_CAPA)}"]`); if (cb) cb.checked=false;
  }
}

async function toggleClassification(layer,value,visible){
  try{
    const entry=await ensureLocalVectorLayer(layer); const ids=entry.classLayerIds?.[String(value)]||[];
    ids.forEach(lid=>state.map.getLayer(lid)&&state.map.setLayoutProperty(lid,'visibility',visible?'visible':'none'));
    state.preferences.classLayers ||= {}; state.preferences.classLayers[classPreferenceId(layer,value)]=visible; savePreferences();
    if(visible){
      state.preferences.layers ||= {}; state.preferences.layers[layer.ID_CAPA]=true;
      const parent=document.querySelector(`[data-layer-toggle="${CSS.escape(layer.ID_CAPA)}"]`);
      if(parent) parent.checked=true;
      savePreferences();
    }
  }catch{
    const cb=document.querySelector(`[data-class-toggle="${CSS.escape(classPreferenceId(layer,value))}"]`);if(cb)cb.checked=false;
  }
}

function setExternalOpacity(layer,opacity,persist=true) {
  opacity=Math.max(0,Math.min(1,Number(opacity)));
  if (persist) { state.preferences.layerOpacity ||= {}; state.preferences.layerOpacity[layer.ID_CAPA]=opacity; savePreferences(); }
  const entry=state.external.get(layer.ID_CAPA); if (!entry) return;
  entry.layerIds.forEach(lid=>{
    if (!state.map.getLayer(lid)) return; const type=state.map.getLayer(lid).type;
    if (type==='raster') state.map.setPaintProperty(lid,'raster-opacity',opacity);
    if (type==='line') state.map.setPaintProperty(lid,'line-opacity',opacity);
    if (type==='circle') state.map.setPaintProperty(lid,'circle-opacity',opacity);
    if (type==='symbol'){
      const isVoltageLabel=Array.isArray(entry.labelLayerIds)&&entry.labelLayerIds.includes(lid);
      state.map.setPaintProperty(lid,'icon-opacity',isVoltageLabel?Math.min(1,opacity+0.10):opacity);
    }
    if (type==='fill') state.map.setPaintProperty(lid,'fill-opacity',polygonFillOpacity(layer,opacity));
  });
}

function groupOpenInitially(group){ return group==='Transporte eléctrico'; }
function subgroupOpenInitially(group,sub){ return group==='Transporte eléctrico' && sub==='Líneas de alta tensión'; }
function protocolLabel(layer){ if(layer.__centralLocal)return 'LOCAL'; if(isLocalVector(layer))return 'LOCAL'; return String(layer.PROTOCOLO||''); }

function syntheticCentralLayer(){ return {ID_CAPA:'CENTRALES_GEOELECTRICO_LOCAL',TITULO:'Centrales Geoeléctrico',DESCRIPCION:'Capa existente del visor 1.0.',GRUPO_MENU:'Generación',SUBGRUPO_MENU:'Centrales',PROTOCOLO:'LOCAL',VISIBLE_INICIAL:'SI',OPACIDAD_INICIAL:Number(state.config?.central_layer_opacity??1),ORGANISMO_NOMBRE:'Geoeléctrico',__centralLocal:true}; }

function renderLayerRow(layer){
  const pref=state.preferences.layers?.[layer.ID_CAPA]; const checked=pref===undefined?yes(layer.VISIBLE_INICIAL):Boolean(pref);
  const opacity=Number(state.preferences.layerOpacity?.[layer.ID_CAPA] ?? (layer.__centralLocal?state.preferences.localCentralesOpacity:undefined) ?? layer.OPACIDAD_INICIAL ?? 0.8);
  const classes=Array.isArray(layer.CLASIFICACIONES)?layer.CLASIFICACIONES:[];
  if(classes.length && isLocalVector(layer)){
    const isPoint=String(layer.TIPO_GEOMETRIA||'').toUpperCase()==='PUNTO';
    const children=classes.map(c=>{
      const id=classPreferenceId(layer,c.valor);
      const cp=state.preferences.classLayers?.[id];
      const on=checked&&(cp===undefined?Boolean(c.visible_inicial):Boolean(cp));
      const color=normalizeHexColor(c.color||layer.COLOR||'#78909C');
      const symbol=isPoint
        ? `<span class="class-symbol square" style="--class-color:${esc(color)};--class-fill:${esc(mixWhite(color,0.82))}"></span>`
        : `<span class="class-symbol line" style="background:${esc(color)};height:${Math.max(2,Math.min(5,Number(c.grosor||2)))}px"></span>`;
      return `<label class="class-row"><input type="checkbox" ${on?'checked':''} data-class-toggle="${esc(id)}" data-layer-id="${esc(layer.ID_CAPA)}" data-class-value="${esc(c.valor)}">${symbol}<span>${esc(c.etiqueta||c.valor)}</span></label>`;
    }).join('');
    return `<div class="layer-row classified"><label class="layer-title-line classified-title"><input type="checkbox" ${checked?'checked':''} data-layer-toggle="${esc(layer.ID_CAPA)}"><span>${esc(layer.TITULO)}</span><span class="protocol local">LOCAL</span><span class="layer-status" data-layer-status="${esc(layer.ID_CAPA)}"></span></label>${children}<div class="layer-opacity"><input type="range" min="0" max="100" value="${Math.round(opacity*100)}" data-layer-opacity="${esc(layer.ID_CAPA)}"><span>${Math.round(opacity*100)}%</span></div><div class="layer-meta">${esc(layer.ORGANISMO_NOMBRE||'')} · ${esc(layer.DESCRIPCION||'')}</div></div>`;
  }
  return `<div class="layer-row"><label class="layer-main"><input type="checkbox" ${checked?'checked':''} data-layer-toggle="${esc(layer.ID_CAPA)}"><span>${esc(layer.TITULO)}</span><span class="protocol ${isLocalVector(layer)||layer.__centralLocal?'local':''}">${esc(protocolLabel(layer))}</span><span class="layer-status" data-layer-status="${esc(layer.ID_CAPA)}"></span></label><div class="layer-opacity"><input type="range" min="0" max="100" value="${Math.round(opacity*100)}" data-layer-opacity="${esc(layer.ID_CAPA)}"><span>${Math.round(opacity*100)}%</span></div><div class="layer-meta">${esc(layer.ORGANISMO_NOMBRE||'')} · ${esc(layer.DESCRIPCION||'')}</div></div>`;
}

function buildLayersUi() {
  const host=$('#external-layers'); const real=(state.catalog.capas||[]).filter(x=>yes(x.ACTIVO)&&yes(x.PUBLICAR)); const all=[syntheticCentralLayer(),...real];
  const groups=new Map();
  all.forEach(l=>{const g=l.GRUPO_MENU||l.CATEGORIA||'Otras capas';const sub=l.SUBGRUPO_MENU||l.SUBCATEGORIA||'General';if(!groups.has(g))groups.set(g,new Map());if(!groups.get(g).has(sub))groups.get(g).set(sub,[]);groups.get(g).get(sub).push(l);});
  const order=['Generación','Transporte eléctrico','Distribución eléctrica','Recursos energéticos renovables','Ambiente y restricciones territoriales','Cartografía complementaria'];
  const entries=[...groups.entries()].sort((a,b)=>(order.indexOf(a[0])<0?99:order.indexOf(a[0]))-(order.indexOf(b[0])<0?99:order.indexOf(b[0]))||a[0].localeCompare(b[0],'es'));
  host.innerHTML=entries.map(([g,subs])=>`<details class="menu-group" ${groupOpenInitially(g)?'open':''}><summary>${esc(g)}</summary><div class="menu-group-body">${[...subs.entries()].map(([sub,items])=>`<details class="menu-subgroup" ${subgroupOpenInitially(g,sub)?'open':''}><summary>${esc(sub)}</summary><div class="menu-subgroup-body">${items.sort((a,b)=>Number(a.ORDEN_VISUAL||0)-Number(b.ORDEN_VISUAL||0)).map(renderLayerRow).join('')}</div></details>`).join('')}</div></details>`).join('');

  all.forEach(layer=>{
    const cb=document.querySelector(`[data-layer-toggle="${CSS.escape(layer.ID_CAPA)}"]`); const range=document.querySelector(`[data-layer-opacity="${CSS.escape(layer.ID_CAPA)}"]`);
    cb?.addEventListener('change',()=>{if(layer.__centralLocal){state.map.setLayoutProperty('centrales','visibility',cb.checked?'visible':'none');state.preferences.layers ||= {};state.preferences.layers[layer.ID_CAPA]=cb.checked;savePreferences();}else toggleExternal(layer,cb.checked);});
    range?.addEventListener('input',()=>{range.nextElementSibling.textContent=`${range.value}%`;const v=Number(range.value)/100;if(layer.__centralLocal){state.map.setPaintProperty('centrales','circle-opacity',circleOpacityExpression(v));state.preferences.localCentralesOpacity=v;savePreferences();}else setExternalOpacity(layer,v);});
    (layer.CLASIFICACIONES||[]).forEach(c=>{const id=classPreferenceId(layer,c.valor);const cbox=document.querySelector(`[data-class-toggle="${CSS.escape(id)}"]`);cbox?.addEventListener('change',()=>toggleClassification(layer,c.valor,cbox.checked));});
  });
  return real;
}

function circleRadiusExpression() {
  return ['interpolate',['linear'],['coalesce',['to-number',['get','POTENCIA_MW']],1],1,5,50,6,200,8,500,11,1000,15,3000,22];
}
function circleColorExpression() {
  const exp=['match',['get','TIPO_MAPA']];
  Object.entries(COLORS).forEach(([k,v])=>exp.push(k,v)); exp.push('#7c8790'); return exp;
}
function strokeWidthExpression() {
  return ['match',['get','CALIDAD_PUBLICACION'],'CONFIRMADA',1.25,'ALTA',0.9,'MEDIA',0.7,'PROVISORIA',1.5,'REVISAR',1.6,'CONFLICTO',2.0,0.75];
}
function strokeColorExpression() {
  return ['match',['get','CALIDAD_PUBLICACION'],'PROVISORIA','#d18b16','REVISAR','#e06f16','CONFLICTO','#c73939','#26323b'];
}
function circleOpacityExpression(mult=1) {
  return ['*',mult,['match',['get','CALIDAD_PUBLICACION'],'PROVISORIA',0.55,'REVISAR',0.52,'CONFLICTO',0.62,0.82]];
}

function addLocalCentrales() {
  const map=state.map; state.currentFiltered=[...state.geo.features];
  map.addSource('centrales',{type:'geojson',data:{type:'FeatureCollection',features:state.currentFiltered}});
  const opacity=Number(state.preferences.localCentralesOpacity ?? state.config.central_layer_opacity ?? 1);
  const pref=state.preferences.layers?.CENTRALES_GEOELECTRICO_LOCAL; const visible=pref===undefined?true:Boolean(pref);
  map.addLayer({id:'centrales',type:'circle',source:'centrales',layout:{visibility:visible?'visible':'none'},paint:{'circle-color':circleColorExpression(),'circle-radius':circleRadiusExpression(),'circle-opacity':circleOpacityExpression(opacity),'circle-stroke-width':strokeWidthExpression(),'circle-stroke-color':strokeColorExpression()}});
  map.on('mouseenter','centrales',()=>map.getCanvas().style.cursor='pointer'); map.on('mouseleave','centrales',()=>map.getCanvas().style.cursor=''); map.on('click','centrales',(e)=>renderDetails(e.features?.[0]?.properties||{}));
}

function setupFilters() {
  const features=state.geo.features;
  const types=[...new Set(features.map(f=>f.properties?.TIPO_MAPA).filter(Boolean))].sort((a,b)=>TYPE_ORDER.indexOf(a)-TYPE_ORDER.indexOf(b));
  $('#type-filters').innerHTML=types.map(t=>`<label class="check-item"><input type="checkbox" value="${esc(t)}" checked data-type-filter><span class="dot" style="background:${COLORS[t]||COLORS.Otra}"></span>${esc(t)}</label>`).join('') || '<span class="muted">Sin datos de centrales.</span>';
  const qualities=[...new Set(features.map(f=>f.properties?.CALIDAD_PUBLICACION).filter(Boolean))].sort((a,b)=>QUALITY_ORDER.indexOf(a)-QUALITY_ORDER.indexOf(b));
  $('#quality-filters').innerHTML=qualities.map(q=>`<label class="check-item"><input type="checkbox" value="${esc(q)}" checked data-quality-filter>${esc(QUALITY_LABEL[q]||q)}</label>`).join('');
  const provinces=[...new Set(features.map(f=>f.properties?.PROVINCIA).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  $('#province').innerHTML='<option value="">Todas</option>'+provinces.map(p=>`<option>${esc(p)}</option>`).join('');
  const maxP=Math.max(100,Math.ceil(Math.max(0,...features.map(f=>Number(f.properties?.POTENCIA_MW)||0))/100)*100);
  $('#capacity').max=maxP||3000;
  $$('[data-type-filter],[data-quality-filter]').forEach(el=>el.addEventListener('change',applyFilters));
  $('#province').addEventListener('change',applyFilters); $('#search').addEventListener('input',applyFilters);
  $('#capacity').addEventListener('input',()=>{$('#capacity-value').textContent=`${$('#capacity').value} MW`;applyFilters();});
  $('#btn-reset').addEventListener('click',resetFilters);
  buildLegend(types);
}

function activeValues(selector){return $$(selector).filter(x=>x.checked).map(x=>x.value);}
function applyFilters(){
  const types=new Set(activeValues('[data-type-filter]')), qs=new Set(activeValues('[data-quality-filter]'));
  const province=$('#province').value, search=$('#search').value.trim().toLowerCase(), minPower=Number($('#capacity').value||0);
  state.currentFiltered=state.geo.features.filter(f=>{
    const p=f.properties||{};
    if(types.size && !types.has(p.TIPO_MAPA))return false;
    if(qs.size && !qs.has(p.CALIDAD_PUBLICACION))return false;
    if(province&&p.PROVINCIA!==province)return false;
    if(minPower>0&&p.POTENCIA_MW!=null&&Number(p.POTENCIA_MW)<minPower)return false;
    if(search){const hay=`${p.CENTRAL||''} ${p.NOMBRE||''} ${p.AGENTE_NEMO||''} ${p.DESCRIPCION_CAMMESA||''}`.toLowerCase();if(!hay.includes(search))return false;}
    return true;
  });
  $('#filtered-count').textContent=fmt(state.currentFiltered.length);
  state.map?.getSource('centrales')?.setData({type:'FeatureCollection',features:state.currentFiltered});
}
function resetFilters(){
  $$('[data-type-filter],[data-quality-filter]').forEach(x=>x.checked=true); $('#province').value='';$('#search').value='';$('#capacity').value=0;$('#capacity-value').textContent='0 MW';applyFilters();
}

function buildLegend(types){
  $('#legend').innerHTML=`<div class="legend-note"><b>Modo 2.1:</b> tamaño = potencia instalada; color = tecnología.</div>${types.map(t=>`<div class="legend-row"><span class="dot" style="background:${COLORS[t]||COLORS.Otra}"></span>${esc(t)}</div>`).join('')}`;
}

function renderDetails(p){
  const rows=[
    ['Central',p.CENTRAL||p.NOMBRE],['Agente',p.AGENTE_NEMO||p.AGENTE],['Tipo',p.TIPO_MAPA],['Provincia',p.PROVINCIA],
    ['Potencia',p.POTENCIA_MW!=null?`${fmt(p.POTENCIA_MW,2)} MW`:'s/d'],['Calidad ubicación',QUALITY_LABEL[p.CALIDAD_PUBLICACION]||p.CALIDAD_PUBLICACION],
    ['Fuente coordenada',p.FUENTE_COORDENADA_PUBLICADA||p.FUENTE_COORDENADA],['Criterio',p.CRITERIO_COORDENADA_PUBLICADA||p.METODO_COORDENADA_PUBLICADA]
  ].filter(r=>r[1]!=null&&String(r[1]).trim()!=='');
  $('#detail-content').innerHTML=rows.map(([k,v])=>`<div class="detail-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('') || '<div class="muted">Seleccione una central.</div>';
}

function renderExternalDetails(layer,p){
  const preferred=['NOMBRE','DENOMINACION','TENSION_KV','TENSION_MAX_KV','OPERADOR','EMPRESA','PROVINCIA','DEPARTAMENTO','LOCALIDAD','ESTADO','ID_GEO'];
  const keys=[...preferred.filter(k=>p[k]!=null&&String(p[k]).trim()!==''),...Object.keys(p).filter(k=>!preferred.includes(k)&&p[k]!=null&&String(p[k]).trim()!=='')].slice(0,16);
  const rows=keys.map(k=>[k.replaceAll('_',' '),p[k]]);
  $('#detail-content').innerHTML=`<div class="detail-source"><b>${esc(layer.TITULO)}</b><span>${esc(layer.ORGANISMO_NOMBRE||'')}</span></div>`+rows.map(([k,v])=>`<div class="detail-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('');
}

function setupStats(){
  const total=state.geo.features.length;
  const unique=new Set(state.geo.features.map(f=>f.properties?.CENTRAL||f.properties?.ID_CAMMESA).filter(Boolean)).size;
  const power=state.geo.features.reduce((s,f)=>s+(Number(f.properties?.POTENCIA_MW)||0),0);
  $('#stat-features').textContent=fmt(total); $('#stat-centrals').textContent=fmt(unique||total); $('#stat-power').textContent=`${fmt(power,0)} MW`; $('#filtered-count').textContent=fmt(total);
}

function setupPanels(){
  $$('.section-toggle').forEach(btn=>btn.addEventListener('click',()=>btn.parentElement.classList.toggle('collapsed')));
  $('#settings-open').addEventListener('click',()=>$('#settings-drawer').classList.add('open'));
  $('#settings-close').addEventListener('click',()=>$('#settings-drawer').classList.remove('open'));
}

async function activateInitialExternal(layers){
  for(const layer of layers){
    const pref=state.preferences.layers?.[layer.ID_CAPA];
    const visible=pref===undefined?yes(layer.VISIBLE_INICIAL):Boolean(pref);
    if(!visible)continue;
    await toggleExternal(layer,true,false);
    const opacity=Number(state.preferences.layerOpacity?.[layer.ID_CAPA]??layer.OPACIDAD_INICIAL??0.8);
    setExternalOpacity(layer,opacity,false);
  }
}

async function init(){
  loadPreferences(); setupPanels();
  state.config=await loadJson('./data/site_config.json',{});
  state.catalog=await loadJson('./data/catalogo_capas.json',{version:'2.1',mapas_base:[],capas:[]});
  applyPreferenceMigrations();
  state.geo=await loadJson('./data/centrales.geojson',{type:'FeatureCollection',features:[]});
  if(!Array.isArray(state.geo.features))state.geo={type:'FeatureCollection',features:[]};
  document.title=state.config.site_title||'Geoeléctrico 2.1';
  $('#site-title').textContent=state.config.site_title||'Geoeléctrico 2.1'; $('#site-subtitle').textContent=state.config.site_subtitle||'Visor energético';
  setupStats(); setupFilters();
  state.map=new maplibregl.Map({container:'map',style:baseStyle(),center:state.config.map_center||[-64,-38],zoom:Number(state.config.map_zoom||3.2),attributionControl:true});
  state.map.addControl(new maplibregl.NavigationControl(),'top-left'); state.map.addControl(new maplibregl.ScaleControl({unit:'metric'}),'bottom-right');
  state.map.on('load',async()=>{
    addLocalCentrales();
    addBasemapSourcesAndLayers();
    buildBasemapUi();
    const layers=buildLayersUi();
    applyFilters();
    await activateInitialExternal(layers);
    addStatus('Geoeléctrico 2.1 inicializado.','ok');
  });
  state.map.on('error',(e)=>console.error('MapLibre:',e?.error||e));
}

init().catch(e=>{
  console.error(e); document.body.innerHTML=`<div class="fatal"><h1>Geoeléctrico 2.1</h1><p>No se pudo iniciar el visor.</p><pre>${esc(e.message)}</pre><p>Ejecute el sitio mediante HTTP local; no abra index.html directamente.</p></div>`;
});
