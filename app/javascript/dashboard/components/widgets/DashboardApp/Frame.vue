<script>
import LoadingState from 'dashboard/components/widgets/LoadingState.vue';

const FETCH_INFO_MESSAGE = 'chatwoot-dashboard-app:fetch-info';
const APP_CONTEXT_EVENT = 'appContext';
/**
 * O app embutido pede a própria altura. Sem isso o iframe fica na altura fixa da lateral e
 * o conteúdo ganha uma segunda barra de rolagem, dentro de um painel que já rola.
 */
const FRAME_HEIGHT_EVENT = 'dashboardApp:height';
const DARK_THEME = 'dark';
const LIGHT_THEME = 'light';

const getCurrentTheme = () =>
  document.body.classList.contains(DARK_THEME) ? DARK_THEME : LIGHT_THEME;

export default {
  components: {
    LoadingState,
  },
  props: {
    config: {
      type: Array,
      default: () => [],
    },
    currentChat: {
      type: Object,
      default: () => ({}),
    },
    isVisible: {
      type: Boolean,
      default: false,
    },
    position: {
      type: Number,
      required: true,
    },
  },
  data() {
    return {
      hasOpenedAtleastOnce: false,
      iframeLoading: true,
      // Altura que cada app pediu, em px. Sem pedido, o app fica na altura fixa do CSS.
      frameHeights: {},
      currentTheme: getCurrentTheme(),
      themeObserver: null,
    };
  },
  computed: {
    dashboardAppContext() {
      return {
        conversation: this.currentChat,
        contact: this.$store.getters['contacts/getContact'](this.contactId),
        currentAgent: this.currentAgent,
        customAttributes: this.customAttributes,
        theme: this.currentTheme,
      };
    },
    customAttributes() {
      return this.$store.getters['attributes/getAttributes'];
    },
    contactId() {
      return this.currentChat?.meta?.sender?.id;
    },
    currentAgent() {
      const { id, name, email } = this.$store.getters.getCurrentUser;
      return { id, name, email };
    },
  },
  watch: {
    // `immediate` porque na lateral o componente só é criado quando a sanfona abre — ou
    // seja, já nasce com `isVisible` verdadeiro, e um watcher comum nunca dispararia:
    // `hasOpenedAtleastOnce` ficaria falso e o iframe não chegaria a ser desenhado.
    // Na aba, onde o componente monta invisível, o comportamento é o mesmo de antes.
    isVisible: {
      immediate: true,
      handler(isVisible) {
        if (isVisible) {
          const hasOpened = this.hasOpenedAtleastOnce;
          this.hasOpenedAtleastOnce = true;
          if (hasOpened) this.sendContextToFrames();
        }
      },
    },
    customAttributes() {
      this.sendContextToFrames();
    },
  },
  mounted() {
    window.addEventListener('message', this.triggerEvent);
    this.themeObserver = new MutationObserver(this.onThemeChange);
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ['class'],
    });
  },
  unmounted() {
    window.removeEventListener('message', this.triggerEvent);
    this.themeObserver.disconnect();
  },
  methods: {
    triggerEvent(event) {
      if (!this.isVisible) return;

      const frameIndex = this.config.findIndex((_, index) => {
        const frameElement = document.getElementById(this.getFrameId(index));
        return frameElement?.contentWindow === event.source;
      });
      if (frameIndex < 0) return;

      if (event.data === FETCH_INFO_MESSAGE) {
        this.sendContext(frameIndex);
        return;
      }

      // O app diz de quanto precisa e o iframe passa a ter essa altura, para o conteúdo
      // não ganhar uma barra de rolagem própria dentro da lateral — quem rola é a lateral.
      const height = this.parseHeightMessage(event.data);
      if (height) this.frameHeights = { ...this.frameHeights, [frameIndex]: height };
    },
    parseHeightMessage(data) {
      if (typeof data !== 'string') return null;
      try {
        const message = JSON.parse(data);
        if (message?.event !== FRAME_HEIGHT_EVENT) return null;
        const height = Number(message.height);
        return Number.isFinite(height) && height > 0 ? Math.ceil(height) : null;
      } catch {
        return null;
      }
    },
    frameStyle(index) {
      const height = this.frameHeights[index];
      return height ? { height: `${height}px` } : {};
    },
    onThemeChange() {
      const theme = getCurrentTheme();
      if (theme === this.currentTheme) return;

      this.currentTheme = theme;
      this.sendContextToFrames();
    },
    getFrameId(index) {
      return `dashboard-app--frame-${this.position}-${index}`;
    },
    sendContextToFrames() {
      if (!this.isVisible || this.iframeLoading) return;
      this.config.forEach((_, index) => this.sendContext(index));
    },
    sendContext(index) {
      // A possible alternative is to use ref instead of document.getElementById
      // However, when ref is used together with v-for, the ref you get will be
      // an array containing the child components mirroring the data source.
      const frameElement = document.getElementById(this.getFrameId(index));
      const eventData = {
        event: APP_CONTEXT_EVENT,
        data: this.dashboardAppContext,
      };
      frameElement.contentWindow.postMessage(JSON.stringify(eventData), '*');
      this.iframeLoading = false;
    },
  },
};
</script>

<!-- eslint-disable-next-line vue/no-root-v-if -->
<template>
  <div v-if="hasOpenedAtleastOnce" class="dashboard-app--container">
    <div
      v-for="(configItem, index) in config"
      :key="index"
      class="dashboard-app--list"
    >
      <LoadingState
        v-if="iframeLoading"
        :message="$t('DASHBOARD_APPS.LOADING_MESSAGE')"
        class="dashboard-app_loading-container"
      />
      <iframe
        v-if="configItem.type === 'frame' && configItem.url"
        :id="getFrameId(index)"
        :src="configItem.url"
        :style="frameStyle(index)"
        @load="() => sendContext(index)"
      />
    </div>
  </div>
</template>

<style scoped>
.dashboard-app--container,
.dashboard-app--list,
.dashboard-app--list iframe {
  /* Mínimo, não fixo: o `style` inline do iframe sobrepõe com a altura que o app pediu. */
  min-height: 100%;
  width: 100%;
}

.dashboard-app--list iframe {
  display: block;
  height: 100%;
  border: 0;
}
.dashboard-app_loading-container {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
}
</style>
