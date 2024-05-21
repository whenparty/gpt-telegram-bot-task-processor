import { Bot, InlineKeyboard } from "grammy";
import throttle from "lodash.throttle";
import { Message } from "@anthropic-ai/sdk/resources";
import Anthropic from "@anthropic-ai/sdk";
import { IRepository, Token } from "db/repository/repository";
import { AI_MODEL, AI_MODEL_API_VERSION } from "db/repository/aiModels";

const DEFAULT_TOKENS = [
  {
    aiModel: AI_MODEL.CLAUDE_3_HAIKU,
    tokens: 1000,
  },
];

export class BotService {
  constructor(readonly bot: Bot, readonly anthropic: Anthropic) {}

  setCommands() {
    this.bot.api.setMyCommands([
      { command: "selectmodel", description: "Select an AI model" },
      { command: "newchat", description: "Start a new chat" },
    ]);

    this.bot.api.setMyCommands(
      [
        { command: "selectmodel", description: "Выберите ИИ" },
        { command: "newchat", description: "Начать новый чат" },
      ],
      { language_code: "ru" }
    );
  }

  subscribeOnUpdate(repository: IRepository) {
    this.bot.command("start", async (ctx) => {
      const { from } = ctx;
      if (!from || from.is_bot) {
        return;
      }

      const userId = from.id.toString();
      let user = await repository.getUserWithTokens(userId);

      if (!user) {
        const tokens = DEFAULT_TOKENS;
        const newUser = await repository.createUser(
          {
            externalIdentifier: from.id.toString(),
            aiModel: AI_MODEL.CLAUDE_3_HAIKU,
            name: [from.username, from.first_name, from.last_name]
              .filter(Boolean)
              .join(" "),
          },
          DEFAULT_TOKENS
        );

        user = {
          ...newUser,
          tokens: tokens as Token[],
        };
      }

      if (!user.tokens.length) {
        await repository.createTokens(user.id, DEFAULT_TOKENS);
      }

      const inlineKeyboard = new InlineKeyboard();
      user.tokens.forEach((token) => {
        const modelTokens = token.tokens < 0 ? "not limited" : token.tokens;
        inlineKeyboard
          .text(`${token.aiModel} / tokens: ${modelTokens}`, token.aiModel)
          .row();
      });
      // Send the menu:
      await ctx.reply("Select the gtp model:", {
        reply_markup: inlineKeyboard,
      });
    });

    this.bot.on("callback_query:data", async (ctx) => {
      const selectedAiModel = ctx.callbackQuery.data as AI_MODEL;
      const externalUserId = ctx.from.id.toString();
      const user = await repository.getUserWithTokens(externalUserId);
      if (!user) {
        throw new Error(`There is no user with id: ${externalUserId}`);
      }

      if (user.aiModel === selectedAiModel) {
        await ctx.editMessageText(
          `The current model is already ${selectedAiModel}`,
          {
            reply_markup: undefined,
          }
        );
        return;
      }

      const availableTokens = user.tokens.find(
        (token) => token.aiModel === selectedAiModel
      );
      if (!availableTokens || availableTokens.tokens === 0) {
        await ctx.answerCallbackQuery({
          text: `Unfortunately you do not have tokens for ${selectedAiModel}. Please select another AI model.`,
        });
      }

      await repository.switchToModel(user.id, selectedAiModel);

      await ctx.editMessageText(
        `Select the gtp model:\nYou chose ${selectedAiModel}`,
        {
          reply_markup: undefined,
        }
      );
    });

    this.bot.on("message:text", async (ctx) => {
      const chatId = ctx.chat.id;

      const externalUserId = ctx.from.id.toString();
      const user = await repository.getUserWithTokens(externalUserId);
      if (!user) {
        throw new Error(`There is no user with id: ${externalUserId}`);
      }

      const availableTokens = user.tokens.find(
        (token) => token.aiModel === user.aiModel
      );
      if (!availableTokens || availableTokens.tokens === 0) {
        await this.bot.api.sendMessage(
          chatId,
          `Unfortunately you do not have tokens for ${user.aiModel}`
        );
        return;
      }

      let answer: string = "";

      const message = await this.bot.api.sendMessage(chatId, "...");
      const messageId = message.message_id;

      const typingChatActionIntervalId = await this.simulateTypingChatAction(
        chatId
      );

      const messages = await repository.findUserMessages(user.id);
      const userMessage = { role: "user" as const, content: ctx.message.text };
      const dialog = [
        ...messages.map((m) => ({ role: m.role, content: m.text })),
        userMessage,
      ];

      this.anthropic.messages
        .stream(
          {
            model: user.aiModel,
            max_tokens: 1024,
            messages: dialog,
          },
          {
            headers: { "anthropic-version": "2023-06-01" },
          }
        )
        .on("text", async (_, text) => {
          if (text !== answer) {
            await this.throttledReplyOrEditMessageText(chatId, messageId, text);

            answer = text;
          }
        })
        .on("finalMessage", async (message: Message) => {
          const text = message.content[0]?.text ?? "";
          const assistantMessage = { role: message.role, text };
          const savingMessages = [userMessage, assistantMessage];
          const tokens =
            message.usage.input_tokens + message.usage.output_tokens;
          let tokensLeft = availableTokens.tokens - tokens;
          if (tokensLeft < 0) {
            tokensLeft = 0;
          }

          clearInterval(typingChatActionIntervalId);
          console.log("end", text);
          console.log("tokens", tokens);
          await repository.saveMessages(
            user.id,
            user.aiModel,
            savingMessages,
            tokensLeft
          );
        });
    });
  }

  async simulateTypingChatAction(chatId: number) {
    try {
      await this.bot.api.sendChatAction(chatId, "typing");

      const intervalId = setInterval(async () => {
        await this.bot.api.sendChatAction(chatId, "typing");
      }, 6 * 1000);

      return intervalId;
    } catch (e) {
      console.log("simulateTypingChatAction", e);
    }
  }

  throttledReplyOrEditMessageText = throttle(this.replyOrEditMessageText, 500, {
    leading: true,
    trailing: true,
  });

  async replyOrEditMessageText(
    chatId: number,
    messageId: number,
    text: string
  ) {
    try {
      await this.bot.api.editMessageText(chatId, messageId, text);
    } catch (e) {
      console.log(e);
    }
  }
}
