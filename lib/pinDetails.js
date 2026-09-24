'use strict';

const {randomUUID} = require('crypto');
const {EngineError, failureOf} = require('./engineError');
const context = require('./jobContext');
const {extractLocationFromComponents, extractLocation} = require('../enrich/locationParser');
const {mapToCategory} = require('../enrich/categories');
const {extractCuisine} = require('../enrich/cuisine');

const SCHEMA = 1;
const COLLECTION = 'pinDetailTasks';
const FIELDS = ['placeName','formattedAddress','latitude','longitude','category','city','region','country',
  'rating','userRatingsTotal','priceLevel','shortFormattedAddress','primaryType','types','cuisine',
  'dineIn','takeout','delivery','reservable','priceRange','openingPeriods','weekdayDescriptions',
  'utcOffsetMinutes','website','phoneNumber','servesBreakfast','servesLunch','servesDinner','servesBrunch',
  'servesBeer','servesWine','servesCocktails','servesCoffee','servesDessert','servesVegetarianFood',
  'outdoorSeating','goodForChildren','goodForGroups','allowsDogs','restroom','menuForChildren','liveMusic',
  'businessStatus','editorialSummary','viewport','paymentOptions','parkingOptions','accessibilityOptions',
  'currentOpeningPeriods','currentWeekdayDescriptions'];
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.includes('/');
const generation = snap => Number.isFinite(snap?.createTime?.seconds)
  ? `${snap.createTime.seconds}:${snap.createTime.nanoseconds}`
  : Number.isFinite(snap?.createTime?.toMillis?.()) ? String(snap.createTime.toMillis()) : null;
const same = (a,b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const MUTABLE_FIELDS = new Set(['placeName','formattedAddress','latitude','longitude','category','city','region','country']);
function clearProviderMetadata(pin) {
  const edited = new Set(Array.isArray(pin.detailsUserEditedFields) ? pin.detailsUserEditedFields : []);
  return Object.fromEntries(FIELDS.filter(key => !MUTABLE_FIELDS.has(key) && !edited.has(key)).map(key => [key,null]));
}
const commitTime = snap => generation({createTime:snap?.updateTime});
// Document commit metadata, unlike client fields, cannot be forged. A pin
// write after our last joint commit may be an old client's same-value edit.
function provenance(task, taskSnap, pinSnap) {
  const pinWriteTime = task.pinWriteSameCommit ? commitTime(taskSnap) : task.pinWriteTime;
  return {pinWriteTime:pinWriteTime || null, pinWriteSameCommit:false,
    protectMutableFields:!!task.protectMutableFields || !pinWriteTime || commitTime(pinSnap)!==pinWriteTime};
}
function mergeKnown(previous, value) {
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) return previous ?? null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    const result = previous && typeof previous === 'object' && !Array.isArray(previous) ? {...previous} : {};
    for (const [key, item] of Object.entries(value)) result[key] = mergeKnown(result[key], item);
    return result;
  }
  return value;
}
const baselineFor = pin => Object.fromEntries(FIELDS.map(key => [key, pin[key] ?? null]));
const needsDetails = pin => pin.detailsSchemaVersion === SCHEMA && pin.detailsState === 'pending' && validId(pin.placeId);

// Called in the SAME transaction that creates the pin. Neither a pin flag nor
// a client-created document can enqueue work; the private outbox is authority.
function enqueueNewPin(txn, db, admin, pinRef, pin) {
  if (!needsDetails(pin)) return;
  const taskId=randomUUID();
  txn.update(pinRef,{detailsTaskId:taskId});
  txn.set(db.collection(COLLECTION).doc(pinRef.id), {
    taskId,
    schemaVersion: SCHEMA, pinId: pinRef.id, userId: pin.userId, placeId: pin.placeId,
    pinGeneration: null, sameCommit: true, pinWriteSameCommit:true, revision: 1, status: 'queued',
    baseline: baselineFor(pin), createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

function mappedDetails(details, baseline) {
  // Reuse the pin serializer's established nested Google field shapes. Lazy
  // import avoids initializing a second enrichment pipeline at module load.
  const {mapAtmosphereFields, mapPriceRange} = require('../enrich');
  const types = [...new Set([...(Array.isArray(baseline.types) ? baseline.types : []), ...(details.types || [])])];
  const location = details.address_components?.length ? extractLocationFromComponents(details.address_components)
    : extractLocation(details.formatted_address || '');
  return {
    placeName: details.name, formattedAddress: details.formatted_address,
    latitude: details.geometry?.location?.lat, longitude: details.geometry?.location?.lng,
    category: mapToCategory(types, details.primary_type), city: location.city, region: location.region, country: location.country,
    rating: details.rating, userRatingsTotal: details.user_ratings_total, priceLevel: details.price_level,
    shortFormattedAddress: details.short_formatted_address, primaryType: details.primary_type,
    types, cuisine: extractCuisine(types, details.primary_type), dineIn: details.dine_in,
    takeout: details.takeout, delivery: details.delivery, reservable: details.reservable,
    ...mapAtmosphereFields(details), priceRange: mapPriceRange(details.price_range),
    openingPeriods: details.opening_periods, weekdayDescriptions: details.weekday_descriptions,
    utcOffsetMinutes: details.utc_offset_minutes, website: details.website, phoneNumber: details.formatted_phone_number,
  };
}

function createPinDetails({db, admin, fetchDetails, now = Date.now, timeoutMs = 45000}) {
  const stamp = () => admin.firestore.FieldValue.serverTimestamp();
  const refs = id => ({task: db.collection(COLLECTION).doc(id), pin: db.collection('pins').doc(id)});
  function samePin(task, taskSnap, pinSnap) {
    const pin = pinSnap.data();
    // Before the first claim, the queued outbox's updateTime is the atomic
    // enqueue commit. Its createTime survives overwrites, and a serverTimestamp
    // field can differ from document commit metadata. Subsequent claims use the
    // captured pin generation. Never trust the client-writable pin.createdAt.
    const expected = task.pinGeneration || (task.sameCommit ? generation({createTime:taskSnap.updateTime}) : null);
    return !!expected && pinSnap.exists && pin?.userId === task.userId
      && generation(pinSnap) === expected;
  }
  const matching = (task,t,pin) => samePin(task,t,pin) && pin.data().placeId===task.placeId
    && pin.data().detailsMetadataReset!==true;
  function cancel(txn,r,task,t,pin,userExists) {
    const bound = samePin(task,t,pin);
    const visible = userExists && bound && pin.data().detailsTaskId===task.taskId
      && pin.data().detailsRevision===task.revision && pin.data().detailsState==='pending';
    // Capture generation before changing the original enqueue commit metadata.
    txn.update(r.task,{...provenance(task,t,pin),status:'cancelled',
      pinGeneration:task.pinGeneration || (task.sameCommit ? commitTime(t) : null),sameCommit:false,
      pinWriteSameCommit:visible,updatedAt:stamp()});
    if (visible) txn.update(r.pin,{...(pin.data().placeId!==task.placeId
      ? {...clearProviderMetadata(pin.data()),detailsMetadataReset:true} : {}),detailsState:'needs_action',updatedAt:stamp()});
  }

  async function claim(id) {
    if (!validId(id)) return null;
    const r = refs(id), owner = randomUUID();
    return db.runTransaction(async txn => {
      const t = await txn.get(r.task), task = t.data();
      if (!task || task.schemaVersion !== SCHEMA || task.status !== 'queued') return null;
      const pin = await txn.get(r.pin), user = await txn.get(db.collection('users').doc(task.userId));
      if (!user.exists || !matching(task, t, pin)) {
        cancel(txn,r,task,t,pin,user.exists); return null;
      }
      const claimed = {...task, ...provenance(task,t,pin), pinGeneration:generation(pin), owner, deadline:now()+timeoutMs, status:'running', dispatched:false};
      txn.update(r.task,{...provenance(task,t,pin),pinGeneration:claimed.pinGeneration,owner,deadline:claimed.deadline,status:'running',dispatched:false,updatedAt:stamp()});
      return claimed;
    });
  }

  async function authorizeDispatch(id, claimed, {validateOnly=false}={}) {
    const r = refs(id);
    await db.runTransaction(async txn => {
      const t = await txn.get(r.task), task=t.data(), pin=await txn.get(r.pin);
      const user=await txn.get(db.collection('users').doc(claimed.userId));
      if (!task || task.taskId!==claimed.taskId || task.status!=='running' || task.owner!==claimed.owner || task.revision!==claimed.revision
          || (!validateOnly && task.dispatched) || task.deadline<=now() || !user.exists || !matching(task,t,pin)) {
        throw new EngineError('attempt_stopped',{stage:'details'});
      }
      if (!validateOnly) txn.update(r.task,{...provenance(task,t,pin),dispatched:true,updatedAt:stamp()});
    });
  }

  async function finish(id, claimed, details, error) {
    const r=refs(id);
    const mapped = details ? mappedDetails(details, claimed.baseline) : null;
    return db.runTransaction(async txn => {
      const t=await txn.get(r.task), task=t.data();
      const snap=await txn.get(r.pin), pin=snap.data();
      const user=await txn.get(db.collection('users').doc(claimed.userId));
      if (!task || task.taskId!==claimed.taskId || task.status!=='running' || task.owner!==claimed.owner || task.revision!==claimed.revision) return 'stale';
      if (!user.exists || !matching(task,t,snap)) {cancel(txn,r,task,t,snap,user.exists);return 'cancelled';}
      const ownership = provenance(task,t,snap);
      if (task.deadline<=now()) error = new EngineError('dependency_timeout',{stage:'details'});
      if (error || !mapped) {
        txn.update(r.task,{...ownership,pinWriteSameCommit:true,status:'needs_action',failure:failureOf(error || new EngineError('dependency_error',{stage:'details'})),updatedAt:stamp()});
        txn.update(r.pin,{detailsState:'needs_action',detailsRevision:task.revision,updatedAt:stamp()});
        return 'needs_action';
      }
      const edited = new Set(Array.isArray(pin.detailsUserEditedFields) ? pin.detailsUserEditedFields : []);
      const patch={};
      for (const key of FIELDS) {
        const value=mapped[key];
        if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
        // Older clients cannot mark a same-value edit, and an acknowledged
        // no-op need not change document commit metadata. Optional enrichment
        // therefore only fills absent core fields; it never reclassifies or
        // relocates an already accepted place. Zero coordinates are populated.
        if (MUTABLE_FIELDS.has(key) && pin[key] !== undefined && pin[key] !== null && pin[key] !== '') continue;
        if (!edited.has(key) && !(ownership.protectMutableFields && MUTABLE_FIELDS.has(key))
            && same(pin[key],task.baseline[key])) patch[key]=mergeKnown(pin[key],value);
      }
      txn.update(r.pin,{...patch,detailsSchemaVersion:SCHEMA,detailsState:'complete',detailsRevision:task.revision,detailsUpdatedAt:stamp(),updatedAt:stamp()});
      txn.update(r.task,{...ownership,pinWriteSameCommit:true,status:'complete',updatedAt:stamp()});
      return 'complete';
    });
  }

  async function process(id) {
    const claimed=await claim(id);
    if (!claimed) return 'skipped';
    // Details have their own authority/deadline. A completed share must never
    // be reset to processing simply to fetch optional business attributes.
    return context.run({userId:claimed.userId,attemptId:`details:${id}:${claimed.revision}`,deadline:claimed.deadline,
      beforeProviderDispatch:()=>authorizeDispatch(id,claimed),
      validateProviderDispatch:()=>authorizeDispatch(id,claimed,{validateOnly:true})},async()=>{
      try {
        const details=await fetchDetails(claimed.placeId,{strict:true,deadline:claimed.deadline,refresh:claimed.revision > 1});
        if (!details) throw new EngineError('dependency_error',{stage:'details'});
        return await finish(id,claimed,details);
      } catch (error) {return finish(id,claimed,null,error);}
    });
  }

  // Crashed/expired dispatched work becomes explicit-action-only. Never run
  // the Google request again just because the worker or its lease disappeared.
  async function expire(id) {
    const r=refs(id);
    const snap=await r.task.get(), task=snap.data();
    if (task?.status!=='running' || task.deadline>now()) return 'skipped';
    return finish(id,task,null,new EngineError('dependency_timeout',{stage:'details'}));
  }

  async function retry(id, uid, revision, taskId) {
    if (!validId(id) || !validId(uid) || !validId(taskId) || !Number.isSafeInteger(revision) || revision<1) throw new EngineError('invalid_response',{stage:'details'});
    const r=refs(id);
    return db.runTransaction(async txn => {
      const t=await txn.get(r.task), task=t.data(), pin=await txn.get(r.pin);
      const user=await txn.get(db.collection('users').doc(uid));
      if (!task || task.schemaVersion!==SCHEMA || task.taskId!==taskId || task.userId!==uid || !user.exists
          || !samePin(task,t,pin) || !validId(pin.data().placeId)) throw new EngineError('access_blocked',{stage:'details'});
      const corrected = pin.data().placeId!==task.placeId;
      const replaceMetadata = corrected || pin.data().detailsMetadataReset===true
        || (task.status==='complete' && pin.data().detailsState==='needs_action');
      // A duplicated/ambiguous HTTP retry returns the same attempt, not a new
      // generation that charges again after the first one has finished.
      if (task.revision!==revision || (!replaceMetadata && !['needs_action','cancelled'].includes(task.status))) return {status:task.status,revision:task.revision};
      // Keep the original baseline on ordinary retry. A corrected place has a
      // new baseline, but its mutable fields remain explicitly user-owned.
      const metadata = replaceMetadata ? clearProviderMetadata(pin.data()) : {};
      txn.update(r.task,{...provenance(task,t,pin),pinWriteSameCommit:true,pinGeneration:generation(pin),
        ...(replaceMetadata ? {placeId:pin.data().placeId,baseline:baselineFor({...pin.data(),...metadata}),protectMutableFields:true} : {}),
        status:'queued',revision:revision+1,owner:null,dispatched:false,deadline:null,failure:null,updatedAt:stamp()});
      txn.update(r.pin,{...metadata,detailsMetadataReset:false,detailsState:'pending',detailsTaskId:taskId,detailsRevision:revision+1,updatedAt:stamp()});
      return {status:'queued',revision:revision+1};
    });
  }
  return {process,expire,retry};
}

module.exports={SCHEMA,COLLECTION,FIELDS,generation,baselineFor,enqueueNewPin,createPinDetails,mappedDetails};
