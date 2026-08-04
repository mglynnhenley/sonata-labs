import type { MethodHandler } from "../route-helpers";
import { authTest } from "./auth";
import { usersList, usersInfo, usersCounts } from "./users";
import {
  conversationsList,
  conversationsInfo,
  conversationsHistory,
  conversationsReplies,
  conversationsMembers,
} from "./conversations";
import {
  conversationsCreate,
  conversationsInvite,
  conversationsJoin,
  conversationsLeave,
  conversationsArchive,
  conversationsUnarchive,
  conversationsSetTopic,
  conversationsSetPurpose,
  conversationsRename,
  conversationsOpen,
  conversationsMark,
} from "./conversations-write";
import {
  chatPostMessage,
  chatUpdate,
  chatDelete,
  chatGetPermalink,
  chatPostEphemeral,
  chatScheduleMessage,
  chatDeleteScheduledMessage,
  chatScheduledMessagesList,
} from "./chat";
import { reactionsGet, reactionsList } from "./reactions";
import { reactionsAdd, reactionsRemove } from "./reactions-write";
import { pinsList } from "./pins";
import { pinsAdd, pinsRemove } from "./pins-write";
import { filesList, filesInfo } from "./files";
import {
  filesUpload,
  filesGetUploadURLExternal,
  filesCompleteUploadExternal,
} from "./files-write";
import { searchMessagesHandler } from "./search";
import {
  teamInfo,
  usersConversations,
  usersLookupByEmail,
  usersSetPresence,
  usersGetPresence,
  emojiList,
} from "./team";

// The Web API method registry. Slack's namespace is flat (chat.postMessage,
// conversations.history, …) so one catch-all route dispatches through this map.
export const METHODS: Record<string, MethodHandler> = {
  // auth
  "auth.test": authTest,
  // users
  "users.list": usersList,
  "users.info": usersInfo,
  "users.counts": usersCounts,
  "users.conversations": usersConversations,
  "users.lookupByEmail": usersLookupByEmail,
  "users.setPresence": usersSetPresence,
  "users.getPresence": usersGetPresence,
  // team / emoji
  "team.info": teamInfo,
  "emoji.list": emojiList,
  // conversations — read
  "conversations.list": conversationsList,
  "conversations.info": conversationsInfo,
  "conversations.history": conversationsHistory,
  "conversations.replies": conversationsReplies,
  "conversations.members": conversationsMembers,
  // conversations — write
  "conversations.create": conversationsCreate,
  "conversations.invite": conversationsInvite,
  "conversations.join": conversationsJoin,
  "conversations.leave": conversationsLeave,
  "conversations.archive": conversationsArchive,
  "conversations.unarchive": conversationsUnarchive,
  "conversations.setTopic": conversationsSetTopic,
  "conversations.setPurpose": conversationsSetPurpose,
  "conversations.rename": conversationsRename,
  "conversations.open": conversationsOpen,
  "conversations.mark": conversationsMark,
  // chat
  "chat.postMessage": chatPostMessage,
  "chat.update": chatUpdate,
  "chat.delete": chatDelete,
  "chat.getPermalink": chatGetPermalink,
  "chat.postEphemeral": chatPostEphemeral,
  "chat.scheduleMessage": chatScheduleMessage,
  "chat.deleteScheduledMessage": chatDeleteScheduledMessage,
  "chat.scheduledMessages.list": chatScheduledMessagesList,
  // reactions
  "reactions.get": reactionsGet,
  "reactions.list": reactionsList,
  "reactions.add": reactionsAdd,
  "reactions.remove": reactionsRemove,
  // pins
  "pins.list": pinsList,
  "pins.add": pinsAdd,
  "pins.remove": pinsRemove,
  // files
  "files.list": filesList,
  "files.info": filesInfo,
  "files.upload": filesUpload,
  "files.getUploadURLExternal": filesGetUploadURLExternal,
  "files.completeUploadExternal": filesCompleteUploadExternal,
  // search
  "search.messages": searchMessagesHandler,
};
