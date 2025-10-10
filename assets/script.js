$(document).ready(function() {
    // --- Global State & Configuration ---
    let player, channels=[], schedule={}, countdownTimers={}, db, autoplayCheckTimer=null;
    const loadedChannelData={}, allVideosMap=new Map();
    let videoCounter=0, playerReady=false, dataReady=false;
    const DB_NAME='YouTubeTVCache', STORE_NAME='videoData', CACHE_TTL_HOURS=24;

    // --- Utility Functions ---
    function parseISO8601Duration(d){if(!d)return 0;const m=d.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);if(!m)return 0;return(parseInt(m[1]||0)*3600)+(parseInt(m[2]||0)*60)+(parseInt(m[3]||0));}
    function timeToSeconds(t){return t.split(':').map(Number).reduce((a,b)=>a*60+b);}
    function binarySearchForVideos(arr,max){let l=0,h=arr.length-1,a=-1;while(l<=h){let m=~~((l+h)/2);if(arr[m].durationInSeconds<=max){a=m;l=m+1;}else{h=m-1;}}return a;}
    function isSlowConnection(){try{if(navigator.connection){if(navigator.connection.saveData){console.log('[Util] Slow Connection: User has Data Saver enabled.');return true;}const slowTypes=['slow-2g','2g'];if(slowTypes.includes(navigator.connection.effectiveType)){console.log(`[Util] Slow Connection: Browser reports effectiveType as '${navigator.connection.effectiveType}'.`);return true;}}}catch(e){}console.log('[Util] Connection is assumed to be fast.');return false;}
    
    // --- IndexedDB Caching ---
    function initDB(){return new Promise((res,rej)=>{console.log('[DB] Initializing IndexedDB...');const r=indexedDB.open(DB_NAME,1);r.onupgradeneeded=e=>{console.log('[DB] Upgrade needed. Creating Object Store.');const i=e.target.result;if(!i.objectStoreNames.contains(STORE_NAME))i.createObjectStore(STORE_NAME,{keyPath:'id'});};r.onsuccess=e=>{console.log('[DB] IndexedDB initialized successfully.');db=e.target.result;res(db);};r.onerror=e=>{console.error('[DB] IndexedDB initialization failed:',e.target.error);rej(e.target.error);};});}
    function getCache(k){return new Promise(r=>{if(!db)return r(null);const t=db.transaction([STORE_NAME],'readonly').objectStore(STORE_NAME).get(k);t.onsuccess=e=>{const d=e.target.result;if(d&&(Date.now()-d.timestamp)/(36e5)<CACHE_TTL_HOURS){console.log(`[DB] Cache HIT for key: ${k}`);r(d.data);}else{if(d)console.log(`[DB] Cache STALE for key: ${k}`);else console.log(`[DB] Cache MISS for key: ${k}`);r(null);}};t.onerror=()=>r(null);});}
    function setCache(k,d){if(!db)return;console.log(`[DB] Caching data for key: ${k}`);db.transaction([STORE_NAME],'readwrite').objectStore(STORE_NAME).put({id:k,data:d,timestamp:Date.now()});}

    // --- Data Loading & UI ---
    async function loadFullChannelVideos(channelId){
        if(loadedChannelData[channelId] && loadedChannelData[channelId].isFull){console.log(`[Data] Full data for ${channelId} is already in memory.`);return;}
        const info=channels.find(c=>c.id===channelId)||(channelId==='mixin'?{fileName:'mixin.json'}:null);if(!info)return;
        let data=await getCache(channelId);
        if(!data){
            try{
                console.log(`[Data] Fetching FULL data for: ${channelId}`);
                const res=await fetch(`./videos/${info.fileName}`);
                if(!res.ok)throw new Error(`Fetch failed for ${info.fileName}`);
                data=await res.json();
                setCache(channelId,data);
            }catch(e){console.error(`[Data] Error loading full data for ${channelId}:`,e);return;}
        }
        data.forEach(v=>{v.durationInSeconds=parseISO8601Duration(v.duration);if(!allVideosMap.has(v.id))allVideosMap.set(v.id,v);});
        data.sort((a,b)=>a.durationInSeconds-b.durationInSeconds);
        data.isFull = true;
        loadedChannelData[channelId]=data;
    }
    
    function buildChannelSelector(){const list=$('#channel-list');list.empty();channels.forEach(c=>list.append(`<label class="channel-item"><input type="checkbox" name="channel" value="${c.id}"> ${c.displayName}</label>`));$('#channel-selector-btn').on('click',e=>{e.stopPropagation();$('#channel-list').toggleClass('show');});$('#channel-list').on('change','input[type="checkbox"]',()=>{console.log('[UI] Channel selection changed.');const sel=[];$('#channel-list input:checked').each(function(){sel.push($(this).val());loadFullChannelVideos($(this).val());});localStorage.setItem('selectedChannels',JSON.stringify(sel));});}
    function populateScheduleTable(scheduleData){const tableBody=$('#schedule-body');tableBody.empty();if(!scheduleData||!scheduleData.schedule)return;scheduleData.schedule.forEach(event=>{const timeString=`${event.startTime.substring(0,5)} - ${event.endTime.substring(0,5)}`;const videoId=event.videos[0];const videoUrl=`https://www.youtube.com/watch?v=${videoId}`;const videoName=event.name||"Scheduled Program";const row=`<tr><td>${timeString}</td><td><a href="${videoUrl}" target="_blank" rel="noopener noreferrer">${videoName}</a></td></tr>`;tableBody.append(row);});}

    // --- Autoplay & Player Control ---
    function loadAndCheckAutoplay(videoOptions){if(!player)return;if(autoplayCheckTimer)clearTimeout(autoplayCheckTimer);console.log(`[Player] Attempting to load video: ${videoOptions.videoId}. Setting 5s autoplay check.`);player.unMute();player.loadVideoById(videoOptions);autoplayCheckTimer=setTimeout(()=>{const state=player.getPlayerState();const isMuted=player.isMuted();if(state!==YT.PlayerState.PLAYING){console.warn('[Autoplay] CHECK FAILED: Video is not playing. Showing overlay.');$('#autoplay-overlay').removeClass('hidden');}else if(isMuted){console.warn('[Autoplay] CHECK FAILED: Unmuted autoplay was blocked by browser. Pausing and showing overlay.');player.pauseVideo();$('#autoplay-overlay').removeClass('hidden');}else{console.log('[Autoplay] CHECK PASSED: Video is playing with sound.');}},5000);}
    window.onYouTubeIframeAPIReady=function(){console.log('[Player] YouTube IFrame API is ready.');player=new YT.Player('player',{height:'100%',width:'100%',playerVars:{'autoplay':1,'controls':1,'showinfo':0,'rel':0,'iv_load_policy':3,'modestbranding':1},events:{'onReady':onPlayerReady,'onStateChange':onPlayerStateChange,'onApiChange':onApiChange}});};
    function onPlayerReady(){playerReady=true;console.log('[Player] Player instance is ready.');const userMuted=localStorage.getItem('userMuted');console.log(`[Player] Reading localStorage 'userMuted': ${userMuted}`);if(userMuted==='true'){console.log('[Player] Muting player based on saved preference.');player.mute();}else{console.log('[Player] Unmuting player based on saved preference.');player.unMute();}if(dataReady)playNextVideo();}
    function onPlayerStateChange(event){if(event.data===YT.PlayerState.PLAYING){if(autoplayCheckTimer)clearTimeout(autoplayCheckTimer);console.log('[Player] State changed to PLAYING. Hiding overlay.');$('#autoplay-overlay').addClass('hidden');}if(event.data===YT.PlayerState.ENDED){console.log('[Player] State changed to ENDED. Triggering next video.');playNextVideo();}}
    function onApiChange(){if(!player||typeof player.isMuted!=='function')return;const isMuted=player.isMuted();if(String(isMuted)!==localStorage.getItem('userMuted')){console.log(`[Player] Mute state changed by user to: ${isMuted}. Saving preference.`);localStorage.setItem('userMuted',isMuted);}}

    // --- Core Video Selection Logic ---
    function playNextVideo(){if(!playerReady||!dataReady){console.warn('[VideoLogic] playNextVideo called, but player or data is not ready. Aborting.');return;}console.log('[VideoLogic] --- Selecting Next Video ---');const now=new Date();const nowSec=now.getHours()*3600+now.getMinutes()*60+now.getSeconds();for(const ev of schedule.schedule){let s=timeToSeconds(ev.startTime),e=timeToSeconds(ev.endTime);let inS=(s<=e)?(nowSec>=s&&nowSec<e):(nowSec>=s||nowSec<e);if(inS){console.log('[VideoLogic] DECISION: Current time is within a scheduled event.');const vId=ev.videos[0];const durStr=ev.duration||findVideoDuration(vId);let vDur=0;if(durStr){vDur=parseISO8601Duration(durStr);}else{console.warn(`[VideoLogic] Duration for scheduled video ${vId} unknown.`);}const secUntilEnd=(e>nowSec)?e-nowSec:(e+86400)-nowSec;const startAt=Math.max(0,vDur-secUntilEnd);console.log(`[VideoLogic] Playing SCHEDULED video: ${vId} at start time: ${startAt}s.`);loadAndCheckAutoplay({videoId:vId,startSeconds:startAt});return;}}
    let timeToNext=Infinity;schedule.schedule.forEach(ev=>{let s=timeToSeconds(ev.startTime);if(s<=nowSec)s+=86400;timeToNext=Math.min(timeToNext,s-nowSec);});console.log(`[VideoLogic] Time until next scheduled event: ${timeToNext} seconds.`);if(timeToNext<=120){console.log('[VideoLogic] DECISION: In 2-minute ramp-up window before a scheduled event.');const vids=getPlayableVideos(timeToNext);if(vids.length>0){const best=vids.reduce((p,c)=>Math.abs(c.durationInSeconds-timeToNext)<Math.abs(p.durationInSeconds-timeToNext)?c:p);console.log(`[VideoLogic] Playing RAMP-UP video: ${best.id} to fill the gap.`);loadAndCheckAutoplay({videoId:best.id});return;}
    const cd=Object.entries(countdownTimers).map(([id,d])=>({id,durationInSeconds:parseISO8601Duration(d)}));let cdVid=cd.find(v=>v.durationInSeconds>timeToNext)||cd.sort((a,b)=>b.durationInSeconds-a.durationInSeconds)[0];if(cdVid){const startAt=Math.max(0,cdVid.durationInSeconds-timeToNext-1);console.log(`[VideoLogic] Playing COUNTDOWN video: ${cdVid.id} at start time: ${startAt}s.`);loadAndCheckAutoplay({videoId:cdVid.id,startSeconds:startAt});return;}}
    videoCounter++;console.log(`[VideoLogic] Video counter is now: ${videoCounter}.`);let chosenVid;const mixinData=loadedChannelData['mixin']||[];if(videoCounter%4===0&&mixinData.length>0){console.log('[VideoLogic] DECISION: Time for a mixin video.');chosenVid=mixinData[~~(Math.random()*mixinData.length)];}
    else{console.log('[VideoLogic] DECISION: Playing a regular video from selected channels.');const maxDur=timeToNext-120;let pVids=getPlayableVideos(maxDur);if(pVids.length>0)chosenVid=pVids[~~(Math.random()*pVids.length)];else{console.warn('[VideoLogic] No video found shorter than ramp-up time. Playing shortest available video as a fallback.');let allVids=getPlayableVideos(Infinity);chosenVid=allVids.length>0?allVids[0]:null;}}
    if(chosenVid){console.log(`[VideoLogic] Selected regular video: ${chosenVid.id}`);loadAndCheckAutoplay({videoId:chosenVid.id});}else{console.error('[VideoLogic] CRITICAL: No video found to play. Retrying in 10 seconds.');setTimeout(playNextVideo,10000);}}
    function getPlayableVideos(maxDur){const sel=JSON.parse(localStorage.getItem('selectedChannels')||'[]');let pVids=[];sel.forEach(id=>{const vids=loadedChannelData[id];if(vids){const lastIdx=binarySearchForVideos(vids,maxDur);if(lastIdx!==-1)pVids=pVids.concat(vids.slice(0,lastIdx+1));}});return pVids;}
    function findVideoDuration(vId){if(allVideosMap.has(vId))return allVideosMap.get(vId).duration;if(countdownTimers[vId])return countdownTimers[vId];return null;}

    // --- Application Initialization ---
    async function initApp(){
        try{
            console.log('[Init] --- Application Initialization Started ---');
            await initDB();
            const tag=document.createElement('script');tag.src="https://www.youtube.com/iframe_api";document.head.appendChild(tag);
            const[cRes,sRes,cdRes]=await Promise.all([fetch('channels.json'),fetch('schedules/english.json'),fetch('countdown.json'),]);
            channels=await cRes.json();schedule=await sRes.json();countdownTimers=await cdRes.json();
            console.log('[Init] Core config files (channels, schedule, countdown) fetched.');
            populateScheduleTable(schedule);
            buildChannelSelector();
            let savedChannels=JSON.parse(localStorage.getItem('selectedChannels'));if(!savedChannels||!savedChannels.length){savedChannels=[channels[0].id];localStorage.setItem('selectedChannels',JSON.stringify(savedChannels));}
            savedChannels.forEach(id=>$(`input[value="${id}"]`).prop('checked',true));
            
            const cachePromises = savedChannels.map(id => getCache(id));
            const cachedResults = await Promise.all(cachePromises);
            const isCacheEmpty = cachedResults.some(result => result === null);
            console.log(`[Init] Cache is empty: ${isCacheEmpty}`);
            
            if (isCacheEmpty && isSlowConnection()) {
                console.log('[Init] STRATEGY: Slow connection & empty cache. Using robust pre-flight.');
                const initialLoadPromises = savedChannels.map(async id => {
                    const info = channels.find(c => c.id === id); if (!info) return;
                    const preflightRes = await fetch(`./videos/${id}_preflight.json`);
                    if (preflightRes.ok) {
                        console.log(`[Init] Pre-flight file found for ${id}. Loading...`);
                        let data = await preflightRes.json();
                        data.forEach(v => { v.durationInSeconds = parseISO8601Duration(v.duration); });
                        data.isFull = false;
                        loadedChannelData[id] = data;
                    } else {
                        console.warn(`[Init] Pre-flight file NOT found for ${id}. Falling back to full load immediately.`);
                        await loadFullChannelVideos(id);
                    }
                });
                await Promise.all(initialLoadPromises);
                console.log('[Init] Initial pre-flight/fallback data loaded. Starting first video.');
                dataReady = true;
                if(playerReady) playNextVideo();
                console.log('[Init] Starting background task to upgrade any partial data to full...');
                await loadFullChannelVideos('mixin');
                const upgradePromises = savedChannels.map(id => loadFullChannelVideos(id));
                await Promise.all(upgradePromises);
                console.log('[Init] Background data upgrade complete.');

            } else {
                console.log('[Init] STRATEGY: Fast connection or cache found. Loading full data directly.');
                await loadFullChannelVideos('mixin');
                const fullLoadPromises = savedChannels.map(id => loadFullChannelVideos(id));
                await Promise.all(fullLoadPromises);
                console.log('[Init] Full data loaded.');
                dataReady = true;
                if(playerReady) playNextVideo();
            }
        }catch(e){console.error("[Init] CRITICAL FAILURE during application initialization:",e);$('body').html('<h1>Error loading application. Please check the console and refresh.</h1>');}
    }
    
    // --- Event Listeners ---
    $(window).on('click',e=>{if(!$('.dropdown-container').is(e.target)&&$('.dropdown-container').has(e.target).length===0)$('#channel-list').removeClass('show');});
    $('#play-button').on('click',()=>{console.log('[UI] User clicked the "Click to Play" overlay.');if(player){player.unMute();player.playVideo();}$('#autoplay-overlay').addClass('hidden');});

    initApp();
});