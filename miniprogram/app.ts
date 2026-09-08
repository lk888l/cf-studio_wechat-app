import { enterBackground } from './services/lifecycle';

App({
  onHide() {
    enterBackground();
  },
});
