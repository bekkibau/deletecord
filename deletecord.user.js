// ==UserScript==
// @name          Deletecord - Mass Delete Discord Messages
// @description   Adds a button to the Discord browser UI to mass delete messages from Discord channels and direct messages
// @description:ja DiscordのブラウザUIにボタンを追加し、Discordのチャンネルおよびダイレクトメッセージからメッセージを一括削除します
// @description:zh-CN 在Discord浏览器UI中添加按钮，以批量删除Discord频道和私信中的消息
// @description:zh-HK 在Discord瀏覽器UI中添加按鈕，以批量刪除Discord頻道和私信中的消息
// @description:fr Ajoute un bouton à l'interface utilisateur du navigateur Discord pour supprimer en masse les messages des canaux et des messages directs de Discord
// @namespace     https://github.com/bekkibau/deletecord
// @version       0.1
// @match         https://discord.com/*
// @supportURL    https://github.com/bekkibau/deletecord/issues
// @contributionURL https://www.buymeacoffee.com/bekkibau
// @grant         none
// @license       MIT
// @downloadURL none
// ==/UserScript==

/**
 * Delete all messages in a Discord channel or DM
 * @param {string} authToken Your authorization token
 * @param {string} authorId Author of the messages you want to delete
 * @param {string} guildId Server were the messages are located
 * @param {string} channelId Channel were the messages are located
 * @param {string} minId Only delete messages after this, leave blank do delete all
 * @param {string} maxId Only delete messages before this, leave blank do delete all
 * @param {string} content Filter messages that contains this text content
 * @param {boolean} hasLink Filter messages that contains link
 * @param {boolean} hasFile Filter messages that contains file
 * @param {boolean} includeNsfw Search in NSFW channels
 * @param {function(string, Array)} extLogger Function for logging
 * @param {function} stopHndl stopHndl used for stopping
 * @author bekkibau <https://www.github.com/bekkibau>
 * @see https://github.com/bekkibau/deletecord
 */
async function deleteMessages(authToken, authorId, guildId, channelId, minId, maxId, content, hasLink, hasFile, includeNsfw, includePinned, searchDelay, deleteDelay, delayIncrement, delayDecrement, delayDecrementPerMsgs, retryAfterMultiplier, extLogger, stopHndl, onProgress) {
    const start = new Date();
    let delCount = 0;
    let failCount = 0;
    let avgPing;
    let lastPing;
    let grandTotal;
    let throttledCount = 0;
    let throttledTotalTime = 0;
    let offset = 0;
    let iterations = -1;

    const wait = async ms => new Promise(done => setTimeout(done, ms));
    const msToHMS = s => `${s / 3.6e6 | 0}h ${(s % 3.6e6) / 6e4 | 0}m ${(s % 6e4) / 1000 | 0}s`;
    const escapeHTML = html => html.replace(/[&<"']/g, m => ({ '&': '&amp;', '<': '&lt;', '"': '&quot;', '\'': '&#039;' })[m]);
    const redact = str => `<span class="priv">${escapeHTML(str)}</span><span class="mask">REDACTED</span>`;
    const queryString = params => params.filter(p => p[1] !== undefined).map(p => p[0] + '=' + encodeURIComponent(p[1])).join('&');
    const ask = async msg => new Promise(resolve => setTimeout(() => resolve(window.confirm(msg)), 10));
    const printDelayStats = () => log.verb(`Delete delay: ${deleteDelay}ms, Search delay: ${searchDelay}ms`, `Last Ping: ${lastPing}ms, Average Ping: ${avgPing | 0}ms`);
    const toSnowflake = (date) => /:/.test(date) ? ((new Date(date).getTime() - 1420070400000) * Math.pow(2, 22)) : date;

    const MAX_LOG_ENTRIES = 1000; // Limit the number of log entries
    const BATCH_SIZE = 100; // Process messages in smaller batches

    const log = {
        entries: [],
        add(type, args) {
            if (this.entries.length >= MAX_LOG_ENTRIES) {
                this.entries.shift(); // Remove the oldest entry
            }
            this.entries.push({ type, args });
            this.display();
        },
        display() {
            logArea.innerHTML = this.entries.map(entry => {
                const style = { '': '', info: 'color:#00b0f4;', verb: 'color:#72767d;', warn: 'color:#faa61a;', error: 'color:#f04747;', success: 'color:#43b581;' }[entry.type];
                return `<div style="${style}">${Array.from(entry.args).map(o => typeof o === 'object' ? JSON.stringify(o, o instanceof Error && Object.getOwnPropertyNames(o)) : o).join('\t')}</div>`;
            }).join('');
            if (autoScroll.checked) logArea.querySelector('div:last-child').scrollIntoView(false);
        },
        debug() { this.add('debug', arguments); },
        info() { this.add('info', arguments); },
        verb() { this.add('verb', arguments); },
        warn() { this.add('warn', arguments); },
        error() { this.add('error', arguments); },
        success() { this.add('success', arguments); },
    };

    // Ensure logArea is correctly referenced
    const logArea = document.querySelector('#deletecord .logarea');

    const adjustDelay = (delta) => {
      //searchDelay += delta; //In reality, the search happens rarely, so the search delay should default to a high value to avoid needing to change it
      deleteDelay += delta;
      //log.verb(`Adjusting delay, by ${delta} ms to ${deleteDelay} ms...`);
    };

    async function recurse() {
        let API_SEARCH_URL;
        if (guildId === '@me') {
            API_SEARCH_URL = `https://discord.com/api/v6/channels/${channelId}/messages/`; // DMs
        }
        else {
            API_SEARCH_URL = `https://discord.com/api/v6/guilds/${guildId}/messages/`; // Server
        }

        const headers = {
            'Authorization': authToken
        };

        let resp;
        try {
            const s = Date.now();
            resp = await fetch(API_SEARCH_URL + 'search?' + queryString([
                ['author_id', authorId || undefined],
                ['channel_id', (guildId !== '@me' ? channelId : undefined) || undefined],
                ['min_id', minId ? toSnowflake(minId) : undefined],
                ['max_id', maxId ? toSnowflake(maxId) : undefined],
                ['sort_by', 'timestamp'],
                ['sort_order', 'desc'],
                ['offset', offset],
                ['has', hasLink ? 'link' : undefined],
                ['has', hasFile ? 'file' : undefined],
                ['content', content || undefined],
                ['include_nsfw', includeNsfw ? true : undefined],
            ]), { headers });
            lastPing = (Date.now() - s);
            avgPing = avgPing > 0 ? (avgPing * 0.9) + (lastPing * 0.1) : lastPing;
        } catch (err) {
            return log.error('Search request threw an error:', err);
        }

        // not indexed yet
        if (resp.status === 202) {
            const w = (await resp.json()).retry_after;
            throttledCount++;
            throttledTotalTime += w;
            log.warn(`This channel wasn't indexed, waiting ${w}ms for discord to index it...`);
            await wait(w);
            return await recurse();
        }

        if (!resp.ok) {
            // searching messages too fast
            if (resp.status === 429) {
                const w = (await resp.json()).retry_after;
                throttledCount++;
                throttledTotalTime += w;
                //adjustDelay(w); // Adjust delay based on retry_after value
                log.warn(`Being rate limited by the API for ${w*1000}ms! Consider increasing search delay...`);
                printDelayStats();
                log.verb(`Cooling down for ${w * retryAfterMultiplier}ms before retrying...`);

                await wait(w * retryAfterMultiplier);
                return await recurse();
            } else {
                return log.error(`Error searching messages, API responded with status ${resp.status}!\n`, await resp.json());
            }
        }

        const data = await resp.json();
        const total = data.total_results;
        if (!grandTotal) grandTotal = total;
        const discoveredMessages = data.messages.map(convo => convo.find(message => message.hit === true));
        const messagesToDelete = discoveredMessages.filter(msg => {
            return msg.type === 0 || msg.type === 6 || (msg.pinned && includePinned);
        });
        const skippedMessages = discoveredMessages.filter(msg => !messagesToDelete.find(m => m.id === msg.id));

        const end = () => {
            log.success(`Ended at ${new Date().toLocaleString()}! Total time: ${msToHMS(Date.now() - start.getTime())}`);
            printDelayStats();
            log.verb(`Rate Limited: ${throttledCount} times. Total time throttled: ${msToHMS(throttledTotalTime)}.`);
            log.debug(`Deleted ${delCount} messages, ${failCount} failed.\n`);
        }

        const etr = msToHMS((searchDelay * Math.round(total / 25)) + ((deleteDelay + avgPing) * total));
        log.info(`Total messages found: ${data.total_results}`, `(Messages in current page: ${data.messages.length}, To be deleted: ${messagesToDelete.length}, System: ${skippedMessages.length})`, `offset: ${offset}`);
        printDelayStats();
        log.verb(`Estimated time remaining: ${etr}`)


        if (messagesToDelete.length > 0) {

            if (++iterations < 1) {
                log.verb(`Waiting for your confirmation...`);
                if (!await ask(`Do you want to delete ~${total} messages?\nEstimated time: ${etr}\n\n---- Preview ----\n` +
                    messagesToDelete.map(m => `${m.author.username}#${m.author.discriminator}: ${m.attachments.length ? '[ATTACHMENTS]' : m.content}`).join('\n')))
                    return end(log.error('Aborted by you!'));
                log.verb(`OK`);
            }

            for (let i = 0; i < messagesToDelete.length; i += BATCH_SIZE) {
                const batch = messagesToDelete.slice(i, i + BATCH_SIZE);
                for (let j = 0; j < batch.length; j++) {
                    const message = batch[j];
                    if (stopHndl && stopHndl() === false) return end(log.error('Stopped by you!'));

                    log.debug(`${((delCount + 1) / grandTotal * 100).toFixed(2)}% (${delCount + 1}/${grandTotal})`,
                        `Deleting ID:${redact(message.id)} <b>${redact(message.author.username + '#' + message.author.discriminator)} <small>(${redact(new Date(message.timestamp).toLocaleString())})</small>:</b> <i>${redact(message.content).replace(/\n/g, '↵')}</i>`,
                        message.attachments.length ? redact(JSON.stringify(message.attachments)) : '');
                    if (onProgress) onProgress(delCount + 1, grandTotal);
                    if (delCount % delayDecrementPerMsgs === 0) { //decrement delay every N processed messages
                      log.verb(`Reducing delete delay automatically by ${delayDecrement}ms...`);
                      adjustDelay(delayDecrement)
                    }

                    let resp;
                    try {
                        const s = Date.now();
                        const API_DELETE_URL = `https://discord.com/api/v6/channels/${message.channel_id}/messages/${message.id}`;
                        resp = await fetch(API_DELETE_URL, {
                            headers,
                            method: 'DELETE'
                        });
                        lastPing = (Date.now() - s);
                        avgPing = (avgPing * 0.9) + (lastPing * 0.1);
                        delCount++;
                        if (onProgress) onProgress(delCount, grandTotal); // Update progress after each delete
                    } catch (err) {
                        log.error('Delete request throwed an error:', err);
                        log.verb('Related object:', redact(JSON.stringify(message)));
                        failCount++;
                    }

                    if (!resp.ok) {
                        // deleting messages too fast
                        if (resp.status === 429) {
                            const w = (await resp.json()).retry_after;
                            throttledCount++;
                            throttledTotalTime += w;
                            adjustDelay(delayIncrement); // Adjust delay based on retry_after value
                            console.log(delayIncrement);
                            log.warn(`Being rate limited by the API for ${w * 1000}ms! Adjusted delete delay to ${deleteDelay}ms.`);
                            printDelayStats();
                            log.verb(`Cooling down for ${w * retryAfterMultiplier}ms before retrying...`);
                            await wait(w * retryAfterMultiplier);
                            j--; // retry
                        } else if (resp.status === 403 || resp.status === 400) {
                            log.warn('Insufficient permissions to delete message. Skipping this message.');
                            offset++;
                            failCount++;
                        } else {
                            log.error(`Error deleting message, API responded with status ${resp.status}!`, await resp.json());
                            log.verb('Related object:', redact(JSON.stringify(message)));
                            failCount++;
                        }
                    }




                    await wait(deleteDelay);
                }
            }

            if (skippedMessages.length > 0) {
                grandTotal -= skippedMessages.length;
                offset += skippedMessages.length;
                log.verb(`Found ${skippedMessages.length} system messages! Decreasing grandTotal to ${grandTotal} and increasing offset to ${offset}.`);
            }

            log.verb(`Searching next messages in ${searchDelay}ms...`, (offset ? `(offset: ${offset})` : ''));
            await wait(searchDelay);

            if (stopHndl && stopHndl() === false) return end(log.error('Stopped by you!'));

            return await recurse();
        } else {
            if (total - offset > 0) {
                log.warn('API returned an empty page, but there are still messages to process. Continuing...');
                offset += 25; // Increment offset to continue pagination
                await wait(searchDelay);
                return await recurse();
            }
            return end();
        }
    }

    log.success(`\nStarted at ${start.toLocaleString()}`);
    log.debug(`authorId="${redact(authorId)}" guildId="${redact(guildId)}" channelId="${redact(channelId)}" minId="${redact(minId)}" maxId="${redact(maxId)}" hasLink=${!!hasLink} hasFile=${!!hasFile}`);
    if (onProgress) onProgress(null, 1);
    return await recurse();
}

//---- User interface ----//

let popover;
let btn;
let stop;

function initUI() {

    // Keep the tab active by periodically triggering DOM mutations
    const keepAliveDiv = document.createElement('div');
    keepAliveDiv.id = 'keep-alive';
    keepAliveDiv.style.display = 'none';
    document.body.appendChild(keepAliveDiv);

    let keepAliveObserver = new MutationObserver(() => {});
    keepAliveObserver.observe(keepAliveDiv, { attributes: true });

    setInterval(() => {
        keepAliveDiv.classList.toggle('active');
    }, 1000);


    const insertCss = (css) => {
        const style = document.createElement('style');
        style.appendChild(document.createTextNode(css));
        document.head.appendChild(style);
        return style;
    }

    const createElm = (html) => {
        const temp = document.createElement('div');
        temp.innerHTML = html;
        return temp.removeChild(temp.firstElementChild);
    }

    insertCss(`
        #deletecord-btn{position: relative; height: 24px;width: auto;-webkit-box-flex: 0;-ms-flex: 0 0 auto;flex: 0 0 auto;margin: 0 8px;cursor:pointer; color: var(--interactive-normal);}
        #deletecord{position:fixed;top:100px;right:10px;bottom:10px;width:780px;z-index:99;color:var(--text-normal);background-color:var(--background-secondary);box-shadow:var(--elevation-stroke),var(--elevation-high);border-radius:4px;display:flex;flex-direction:column}
        #deletecord a{color:#00b0f4}
        #deletecord.redact .priv{display:none!important}
        #deletecord:not(.redact) .mask{display:none!important}
        #deletecord.redact [priv]{-webkit-text-security:disc!important}
        #deletecord .toolbar span{margin-right:8px}
        #deletecord button,#deletecord .btn{color:#fff;background:#7289da;border:0;border-radius:4px;font-size:14px}
        #deletecord button:disabled{display:none}
        #deletecord input[type="text"],#deletecord input[type="search"],#deletecord input[type="password"],#deletecord input[type="datetime-local"],#deletecord input[type="number"]{background-color:#202225;color:#b9bbbe;border-radius:4px;border:0;padding:0 .5em;height:24px;width:144px;margin:2px}
        #deletecord input#file{display:none}
        #deletecord hr{border-color:rgba(255,255,255,0.1)}
        #deletecord .header{padding:12px 16px;background-color:var(--background-tertiary);color:var(--text-muted)}
        #deletecord .form{padding:8px;background:var(--background-secondary);box-shadow:0 1px 0 rgba(0,0,0,.2),0 1.5px 0 rgba(0,0,0,.05),0 2px 0 rgba(0,0,0,.05)}
        #deletecord .logarea{overflow:auto;font-size:.75rem;font-family:Consolas,Liberation Mono,Menlo,Courier,monospace;flex-grow:1;padding:10px}
    `);

    popover = createElm(`
    <div id="deletecord" style="display:none;">
        <div class="header">
            deletecord - mass delete messages
        </div>
        <div class="form">
            <div style="display:flex;flex-wrap:wrap;">
                <span>Authorization <a
                        href="https://github.com/bekkibau/deletecord/wiki/authToken" title="Help"
                        target="_blank">?</a> <button id="getToken">get</button><br>
                    <input type="password" id="authToken" placeholder="Auth Token" autofocus>*<br>
                    <span>Author <a href="https://github.com/bekkibau/deletecord/wiki/authorId"
                            title="Help" target="_blank">?</a> <button id="getAuthor">get</button></span>
                    <br><input id="authorId" type="text" placeholder="Author ID" priv></span>
                <span>Guild/Channel <a
                        href="https://github.com/bekkibau/deletecord/wiki/channelId" title="Help"
                        target="_blank">?</a>
                    <button id="getGuildAndChannel">get</button><br>
                    <input id="guildId" type="text" placeholder="Guild ID" priv><br>
                    <input id="channelId" type="text" placeholder="Channel ID" priv><br>
                    <label><input id="includeNsfw" type="checkbox">NSFW Channel</label><br><br>
                    <label for="file" title="Import list of channels from messages/index.json file"> Import: <span
                            class="btn">...</span> <input id="file" type="file" accept="application/json,.json"></label>
                </span><br>
                <span>Range <a href="https://github.com/bekkibau/deletecord/wiki/messageId"
                        title="Help" target="_blank">?</a><br>
                    <input id="minDate" type="datetime-local" title="After" style="width:auto;"><br>
                    <input id="maxDate" type="datetime-local" title="Before" style="width:auto;"><br>
                    <input id="minId" type="text" placeholder="After message with Id" priv><br>
                    <input id="maxId" type="text" placeholder="Before message with Id" priv><br>
                </span>
                <span>Search messages <a
                        href="https://github.com/bekkibau/deletecord/wiki/filters" title="Help"
                        target="_blank">?</a><br>
                    <input id="content" type="text" placeholder="Containing text" priv><br>
                    <label><input id="hasLink" type="checkbox">has: link</label><br>
                    <label><input id="hasFile" type="checkbox">has: file</label><br>
                    <label><input id="includePinned" type="checkbox">Include pinned</label>
                </span><br>
                <span>Search Delay <a
                href="https://github.com/bekkibau/deletecord/wiki/delay" title="Help"
                target="_blank">?</a><br>
                    <input id="searchDelay" type="number" value="1500" step="100"><br>
                </span>
                <span>Delete Delay <a
                href="https://github.com/bekkibau/deletecord/wiki/delay" title="Help"
                target="_blank">?</a><br>
                    <input id="deleteDelay" type="number" value="1400" step="100">
                </span>
            </div>
            <hr>
            <button id="start" style="background:#43b581;width:80px;">Start</button>
            <button id="stop" style="background:#f04747;width:80px;" disabled>Stop</button>
            <button id="clear" style="width:80px;">Clear log</button>
            <label><input id="autoScroll" type="checkbox" checked>Auto scroll</label>
            <label title="Hide sensitive information for taking screenshots"><input id="redact" type="checkbox">Screenshot
                mode</label>
            <progress id="progress" style="display:none;"></progress> <span class="percent"></span>
        </div>
        <pre class="logarea">
            <center>Star this project on <a href="https://github.com/bekkibau/deletecord" target="_blank">github.com/bekkibau/deletecord</a>!\n\n
                <a href="https://github.com/bekkibau/deletecord/issues" target="_blank">Issues or help</a>
            </center>
        </pre>
    </div>
    `);

    document.body.appendChild(popover);

    btn = createElm(`<div id="deletecord-btn" tabindex="0" role="button" aria-label="Delete Messages" title="Delete Messages">
    <svg aria-hidden="false" width="24" height="24" viewBox="0 0 24 24">
        <path fill="currentColor" d="M15 3.999V2H9V3.999H3V5.999H21V3.999H15Z"></path>
        <path fill="currentColor" d="M5 6.99902V18.999C5 20.101 5.897 20.999 7 20.999H17C18.103 20.999 19 20.101 19 18.999V6.99902H5ZM11 17H9V11H11V17ZM15 17H13V11H15V17Z"></path>
    </svg>
    <br><progress style="display:none; width:24px;"></progress>
</div>`);

    btn.onclick = function togglePopover() {
        if (popover.style.display !== 'none') {
            popover.style.display = 'none';
            btn.style.color = 'var(--interactive-normal)';
        }
        else {
            popover.style.display = '';
            btn.style.color = '#f04747';
        }
    };

    function mountBtn() {
        const toolbar = document.querySelector('[class^=toolbar]');
        if (toolbar) toolbar.appendChild(btn);
    }

    const observer = new MutationObserver(function (_mutationsList, _observer) {
        if (!document.body.contains(btn)) mountBtn(); // re-mount the button to the toolbar
    });
    observer.observe(document.body, { attributes: false, childList: true, subtree: true });

    mountBtn();

    const $ = s => popover.querySelector(s);
    const logArea = $('pre');
    const startBtn = $('button#start');
    const stopBtn = $('button#stop');
    const autoScroll = $('#autoScroll');

    startBtn.onclick = async e => {
        const authToken = $('input#authToken').value.trim();
        const authorId = $('input#authorId').value.trim();
        const guildId = $('input#guildId').value.trim();
        const channelIds = $('input#channelId').value.trim().split(/\s*,\s*/);
        const minId = $('input#minId').value.trim();
        const maxId = $('input#maxId').value.trim();
        const minDate = $('input#minDate').value.trim();
        const maxDate = $('input#maxDate').value.trim();
        const content = $('input#content').value.trim();
        const hasLink = $('input#hasLink').checked;
        const hasFile = $('input#hasFile').checked;
        const includeNsfw = $('input#includeNsfw').checked;
        const includePinned = $('input#includePinned').checked;
        const searchDelay = parseInt($('input#searchDelay').value.trim());
        const deleteDelay = parseInt($('input#deleteDelay').value.trim());
        const delayIncrement = 150; //ms
        const delayDecrement = -50; //ms
        const delayDecrementPerMsgs = parseInt("1000") //msgs; 1000 messages at ~1300ms delay is about half an hour.
        const retryAfterMultiplier = 3000; //1000 to convert to seconds, 3x for extra delay
        const progress = $('#progress');
        const progress2 = btn.querySelector('progress');
        const percent = $('.percent');

        const fileSelection = $("input#file");
        fileSelection.addEventListener("change", () => {
            const files = fileSelection.files;
            const channelIdField = $('input#channelId');
            if (files.length > 0) {
                const file = files[0];
                file.text().then(text => {
                    let json = JSON.parse(text);
                    let channels = Object.keys(json);
                    channelIdField.value = channels.join(",");
                });
            }
        }, false);

        const stopHndl = () => !(stop === true);

        const onProg = (value, max) => {
            if (value && max && value > max) max = value;
            progress.setAttribute('max', max);
            progress.value = value;
            progress.style.display = max ? '' : 'none';
            progress2.setAttribute('max', max);
            progress2.value = value;
            progress2.style.display = max ? '' : 'none';
            percent.innerHTML = value && max ? Math.round(value / max * 100) + '%' : '';
        };


        stop = stopBtn.disabled = !(startBtn.disabled = true);
        for (let i = 0; i < channelIds.length; i++) {
            await deleteMessages(authToken, authorId, guildId, channelIds[i], minId || minDate, maxId || maxDate, content, hasLink, hasFile, includeNsfw, includePinned, searchDelay, deleteDelay, delayIncrement, delayDecrement, delayDecrementPerMsgs,retryAfterMultiplier, logger, stopHndl, onProg);
            stop = stopBtn.disabled = !(startBtn.disabled = false);
        }
    };
    stopBtn.onclick = e => stop = stopBtn.disabled = !(startBtn.disabled = false);
    $('button#clear').onclick = e => { logArea.innerHTML = ''; };
    $('button#getToken').onclick = e => {
        window.dispatchEvent(new Event('beforeunload'));
        const ls = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;
        $('input#authToken').value = JSON.parse(localStorage.token);
    };
    $('button#getAuthor').onclick = e => {
        $('input#authorId').value = JSON.parse(localStorage.user_id_cache);
    };
    $('button#getGuildAndChannel').onclick = e => {
        const m = location.href.match(/channels\/([\w@]+)\/(\d+)/);
        $('input#guildId').value = m[1];
        $('input#channelId').value = m[2];
    };
    $('#redact').onchange = e => {
        popover.classList.toggle('redact') &&
            window.alert('This will attempt to hide personal information, but make sure to double check before sharing screenshots.');
    };

    const logger = (type = '', args) => log.add(type, args); // Use log.add method

    // fixLocalStorage
    window.localStorage = document.body.appendChild(document.createElement('iframe')).contentWindow.localStorage;
}

initUI();


//END.