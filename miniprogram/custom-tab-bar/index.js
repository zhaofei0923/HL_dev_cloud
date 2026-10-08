"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const user_navigation_1 = require("../utils/user-navigation");
Component({
    data: {
        active: 'members'
    },
    lifetimes: {
        attached() {
            this.syncActiveTab();
        }
    },
    pageLifetimes: {
        show() {
            this.syncActiveTab();
        }
    },
    methods: {
        syncActiveTab() {
            const pages = getCurrentPages();
            const page = pages[pages.length - 1];
            const active = page ? (0, user_navigation_1.userTabKeyForRoute)(page.route) : null;
            if (active && active !== this.data.active)
                this.setData({ active });
        }
    }
});
