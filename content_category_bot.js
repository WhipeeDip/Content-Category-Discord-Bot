/*
* File name: content_category_bot.js
* Description: Handles the bot stuff and all the relevant API calls.
*/

const Promise = require('bluebird');
const fs = require('fs');
const util = require('util');

const language = require('@google-cloud/language');
const languageClient = new language.LanguageServiceClient();
const Mercury = require('@postlight/mercury-parser');
const promisifyRequest = util.promisify(require('request'));

// require() this and pass in the discord.js logged in client
module.exports = function(discordClient) {
    const MSG_REMOVED = '%s Your message was moved to %s.';
    const MSG_NEW = 'I am %d%% confident that %s posted something in %s that is categorized as %s.';
    const CMD_CATEGORY_CHANNEL_NOT_FOUND = 'CATEGORY_CHANNEL_FILE was not found in your env vars.';
    const CMD_CATEGORY_CHANNEL_ERR = 'Error reading the CATEGORY_CHANNEL_FILE. Make sure it is formatted properly, the file exists, and that you have permissions to read it.';
    const CMD_MAX_NL_NOT_FOUND = 'MAX_NL_UNITS was not found in your env vars.';
    const CMD_MAX_NL_RANGE = 'MAX_NL_UNITS must be > 0.';
    const CMD_CONFIDENCE_NOT_FOUND = 'CONFIDENCE_CUTOFF was not found in your env vars.';
    const CMD_CONFIDENCE_RANGE = 'CONFIDENCE_CUTOFF must be > 0 and <= 1.';
    const CMD_CHARS_NON_NOT_FOUND = 'CHARS_NON_URL was not found in your env vars.';
    const CMD_CHARS_NON_RANGE = 'CHARS_NON_URL must be > 0.';

    const HTTP_REGEX_STR = String.raw`https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{2,256}\.[a-z]{2,6}\b([-a-zA-Z0-9@:%_\+.~#?&//=]*)`;
    const httpRegex = new RegExp(HTTP_REGEX_STR, 'g');
    const REDDIT_REGEX_STR = String.raw`reddit.com/r/.*/comments/`;
    const redditRegex = new RegExp(REDDIT_REGEX_STR, 'g');

    let categoryToChannel;
    let informedMoved = true;
    let ignoredChannels = {};
    let ignoredRoles = [];
    const confidenceCutoff = process.env.CONFIDENCE_CUTOFF;
    const maxNlUnits = process.env.MAX_NL_UNITS;
    const charsNonUrl = process.env.CHARS_NON_URL;
    const nlToCharMult = 1000;

    // callback used after the mercury API is requested
    const createArticlePlainText = (mercuryObj) => {
        console.log('creating article plain text');
        if (mercuryObj === undefined) {
            throw new Error('mercuryObj is undefined');
        }

        let title = mercuryObj.title;
        let excerpt = mercuryObj.excerpt;
        let content = mercuryObj.content;
        let domain = mercuryObj.domain;
        let author = mercuryObj.author;

        let fullStr = '';
        if (title !== undefined) {
            fullStr += title + '\n';
        }

        if (author !== undefined) {
            fullStr += author + '\n';
        }

        if (excerpt !== undefined) {
            fullStr += excerpt + '\n';
        }

        if (content !== undefined) {
            // special handling for strange twitter parsing
            if (!(domain !== undefined && domain.indexOf('twitter.com') > 0)) {
                fullStr += content + '\n';
            }
        }

        if (fullStr.length === 0) {
            throw new Error('Mercury object does not seem to have any relevant fields filled!');
        }

        return fullStr;
    };

    // calls the mercury parsing API and calls the callback with the JSON object
    const mercuryParseArticle = async (url) => {
        console.log(`parsing article ${url}`);

        try {
            let result = await Mercury.parse(url);
            return result;
        } catch (err) {
            console.error(err);
            return undefined;
        }
    };

    // grabs the url this reddit post links to if it exists; else, parse the title and subreddit
    const redditParseListing = async(url) => {
        console.log('parsing reddit post');

        let jsonUrl = url + '.json'; // grab json data from reddit link
        try {
            let requestResult = await promisifyRequest(jsonUrl);
            if (requestResult.error) {
                console.error(requestResult.error);
                return undefined;
            }

            if (requestResult.statusCode === 200) {
                let result = JSON.parse(requestResult.body);
                if (result[0].kind !== 'Listing') {
                    console.log('reddit link is not a listing');
                    let mercury = await mercuryParseArticle(url);
                    return mercury;
                }

                // fields as observed by going to various reddit posts and appending /.json
                let post = result[0].data.children[0].data;
                let title = post.title;
                let subreddit = post.subreddit_name_prefixed;
                let postUrl = post.url;
                let selftext = post.selftext;
                console.log(`Title: ${title}\nSubreddit: ${subreddit}\nURL: ${postUrl}`);

                if (selftext !== undefined && selftext.length > 0) {
                    // selfpost with content
                    console.log('reddit link is a selfpost');
                    return {
                        'title': title,
                        'author': subreddit,
                        'content': selftext
                    };
                } else {
                    // link, external or possibly links to elsewhere on reddit
                    return await parseLink(postUrl);
                }
            } else {
                console.error('did not get HTTP 200');
                return undefined;
            }
        } catch (err) {
            console.error(err);
            return undefined;
        }
    };

    // automatically determines which parsing method to use
    // output should match the mercury format
    const parseLink = async(url) => {
        if (redditRegex.exec(url) !== null) {
            return await redditParseListing(url);
        } else {
            return await mercuryParseArticle(url);
        }
    };

    // runs the google cloud natural language API to classify the text
    // returns an object for the category with the highest confidence {category, confidence}
    const classifyContent = async (text) => {
        console.log('classifying');

        let trimmedText = text.substring(0, (nlToCharMult * maxNlUnits));
        const document = {
            'content': trimmedText,
            'type': 'PLAIN_TEXT'
        };

        let maxConfidence = undefined;
        let maxCategory = undefined;

        try {
            let results = await languageClient.classifyText({'document': document});

            let classification = results[0];
            maxConfidence = undefined;
            maxCategory = undefined;
            classification.categories.forEach((category) => {
                // use the highest confidence category to determine message

                let name = category.name;
                let confidence = category.confidence;

                if (categoryToChannel[name] === undefined) {
                    return;
                }

                console.log(`Category: ${name}\nConfidence: ${confidence}`);

                if (maxConfidence === undefined || maxCategory === undefined) {
                    maxConfidence = confidence;
                    maxCategory = name;
                    return;
                }

                if (confidence > maxConfidence) {
                    maxConfidence = confidence;
                    maxCategory = name;
                    return;
                }
            });
        } catch (err) {
            console.error(err);
            return undefined;
        }

        return {
            'category': maxCategory,
            'confidence': maxConfidence
        };
    };

    discordClient.on('message', async (msg) => {
        // ignore self
        if (msg.author.id === discordClient.user.id) {
            return;
        }

        // if ignored channel, skip
        if (ignoredChannels[msg.channel.name] !== undefined) {
            return;
        }

        // if has ignored role(s), skip
        if (msg.member.roles.some((ele) => ignoredRoles.includes(ele.name))) {
            return;
        }

        let msgContent = msg.content;
        let originalChannel = msg.channel;

        // grab EVERY URL in message
        let urls = [];
        let tmpArr = [];
        while ((tmpArr = httpRegex.exec(msgContent)) !== null) {
            urls.push(tmpArr[0]);
            console.log(tmpArr[0]);
        }

        let matched = false;
        let result = undefined;
        if (urls.length === 0) { // no URLs
            if (msgContent.length < charsNonUrl || msgContent.indexOf(' ') < 0) { // no URLs, not long enough or no spaces
                return;
            }

            console.log(msgContent);

            // classify message text itself
            let textResult = await classifyContent(msgContent);
            if (textResult === undefined) {
                return;
            }

            if (textResult.confidence >= confidenceCutoff) {
                matched = true;
                result = textResult;
            }
        } else {
            // classify every single URL detected
            let urlTexts = [];
            try {
                urlTexts = await Promise.map(urls, async (url) => {
                    let mercuryObj = await parseLink(url);
                    if (mercuryObj === undefined) {
                        return null;
                    }

                    let urlText = createArticlePlainText(mercuryObj);
                    return urlText;
                });

                if (urlTexts.length === 0) {
                    console.error('error while parsing URL(s)');
                    return;
                }

                await Promise.each(urlTexts, async (urlText) => {
                    if (matched || urlText === null) {
                        return;
                    }

                    let urlResult = await classifyContent(urlText);
                    if ((urlResult !== undefined) && (urlResult.confidence >= confidenceCutoff)) {
                        matched = true;
                        result = urlResult;
                    }
                });
            } catch (err) {
                console.error(err);
                return;
            }
        }

        console.log(`matched: ${matched}\n`);
        if (!matched) {
            return;
        }

        let newChannelName = categoryToChannel[result.category];
        if (newChannelName === undefined) {
            console.error(`Could not find channel mapping with category ${result.category}`);
            return;
        }

        let newChannel = msg.guild.channels.find(channel => channel.name === newChannelName);
        if (newChannel == undefined) {
            console.error(`Could not find channel with name ${newChannelName}`);
            return;
        }

        // don't want to move things that are already where they should be
        if (newChannel.id === originalChannel.id) {
            console.log('was from same channel');
            return;
        }

        // delete old message, inform user, send new
        try {
            let user = msg.author;

            msg.delete();
            if (informedMoved) {
                originalChannel.send(util.format(MSG_REMOVED, user, newChannel));
            }

            let confidencePercent = result.confidence * 100;
            await newChannel.send(util.format(MSG_NEW, confidencePercent, user, originalChannel, result.category));
            newChannel.send(msgContent);
        } catch (err) {
            console.error(err);
            return;
        }
    });

    // init
    (function() {
        if (confidenceCutoff === undefined) {
            console.error(CMD_CONFIDENCE_NOT_FOUND);
            process.exit(1);
        } else if (!(confidenceCutoff > 0 && confidenceCutoff <= 1)) {
            console.error(CMD_CONFIDENCE_RANGE);
            process.exit(1);
        }

        if (maxNlUnits === undefined) {
            console.error(CMD_MAX_NL_NOT_FOUND);
            process.exit(1);
        } else if (maxNlUnits <= 0) {
            console.error(CMD_MAX_NL_RANGE);
            process.exit(1);
        }

        if (charsNonUrl === undefined) {
            console.error(CMD_CHARS_NON_NOT_FOUND);
            process.exit(1);
        } else if (charsNonUrl <= 0) {
            console.error(CMD_CHARS_NON_RANGE);
            process.exit(1);
        }

        if (process.env.INFORM_MOVED !== undefined) {
            informedMoved = process.env.informedMoved == 'true';
        }

        if (process.env.IGNORED_CHANNELS !== undefined && process.env.IGNORED_CHANNELS.length > 0) {
            let splitStr = process.env.IGNORED_CHANNELS.split(';');
            splitStr.forEach((channel) => {
                if (channel.length === 0) {
                    return;
                }

                ignoredChannels[channel] = true;
            });
        }

        if (process.env.IGNORED_ROLES !== undefined && process.env.IGNORED_ROLES.length > 0) {
            let splitStr = process.env.IGNORED_ROLES.split(';');
            splitStr.forEach((role) => {
                if (role.length === 0) {
                    return;
                }

                ignoredRoles.push(role);
            });
        }

        if (process.env.CATEGORY_CHANNEL_FILE === undefined) {
            console.error(CMD_CATEGORY_CHANNEL_NOT_FOUND);
            process.exit(1);
        } else {
            try {
                categoryToChannel = JSON.parse(fs.readFileSync(process.env.CATEGORY_CHANNEL_FILE));
            } catch (err) {
                console.error(CMD_CATEGORY_CHANNEL_ERR);
                process.exit(1);
            }
        }
    })();
};
