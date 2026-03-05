// ==UserScript==
// @name         ShanghaiTech Coursebench Integration
// @namespace    http://tampermonkey.net/
// @version      1.6
// @description  将 Coursebench 的课程评价数据集成到上海科技大学选课系统中
// @match        *://eams.shanghaitech.edu.cn/*
// @grant        GM_xmlhttpRequest
// @connect      coursebench.org
// @connect      coursebench.zambar.dev
// ==/UserScript==

(function() {
    'use strict';

    const LOG_PREFIX = "[Coursebench 助手]";

    // 服务器列表，按优先级排序
    const API_ENDPOINTS = [
        "https://coursebench.org/v1/course/all",
        "https://coursebench.zambar.dev/v1/course/all"
    ];

    // 1. 获取所有课程数据（带有自动切换服务器逻辑）
    function fetchCourseData(serverIndex = 0) {
        // 如果所有服务器都已经尝试过了，触发警报并终止
        if (serverIndex >= API_ENDPOINTS.length) {
            console.error(`${LOG_PREFIX} 所有服务器均不可用或请求超时。`);
            alert("Coursebench 助手提示：\n无法获取课程评价数据，所有服务器均连接失败或超时，请稍后再试！");
            return;
        }

        const currentUrl = API_ENDPOINTS[serverIndex];
        console.log(`${LOG_PREFIX} 开始拉取数据 (尝试 ${serverIndex + 1}/${API_ENDPOINTS.length}): ${currentUrl}`);

        GM_xmlhttpRequest({
            method: "GET",
            url: currentUrl,
            timeout: 10000, // 设置 10 秒超时
            onload: function(response) {
                if (response.status === 200) {
                    try {
                        const responseData = JSON.parse(response.responseText);

                        if (responseData.error === false && Array.isArray(responseData.data)) {
                            const courseMap = {};
                            responseData.data.forEach(course => {
                                courseMap[course.code] = course;
                            });
                            console.log(`${LOG_PREFIX} 成功映射 ${responseData.data.length} 门课程。开启表格智能监听...`);
                            observeTables(courseMap);
                        } else {
                            console.error(`${LOG_PREFIX} API 数据格式异常，尝试切换服务器...`);
                            fetchCourseData(serverIndex + 1);
                        }
                    } catch (e) {
                        console.error(`${LOG_PREFIX} JSON 解析失败，尝试切换服务器...`);
                        fetchCourseData(serverIndex + 1);
                    }
                } else {
                    console.error(`${LOG_PREFIX} API 请求失败，HTTP 状态码: ${response.status}，尝试切换服务器...`);
                    fetchCourseData(serverIndex + 1);
                }
            },
            onerror: function(err) {
                console.error(`${LOG_PREFIX} 网络请求发生错误，尝试切换服务器...`);
                fetchCourseData(serverIndex + 1);
            },
            ontimeout: function() {
                console.error(`${LOG_PREFIX} 请求超时 (10秒)，尝试切换服务器...`);
                fetchCourseData(serverIndex + 1);
            }
        });
    }

    // 2. 智能监听并处理动态表格
    function observeTables(courseMap) {
        setInterval(() => {
            const tables = document.querySelectorAll('table');

            tables.forEach((table) => {
                const thead = table.querySelector('thead');
                const tbody = table.querySelector('tbody');
                if (!thead || !tbody) return;

                let headerRow = null;
                let codeIdx = -1;
                let actionIdx = -1;

                // 记录进入本轮检测前，表格是否已经注入过表头
                const wasHeaderInjected = table.hasAttribute('data-cb-header');

                // 步骤A：在整个 thead 里全覆盖扫描，寻找核心标题位
                const headRows = thead.querySelectorAll('tr');
                for (let i = 0; i < headRows.length; i++) {
                    const headers = headRows[i].children;
                    for (let j = 0; j < headers.length; j++) {
                        const text = (headers[j].textContent || '').trim();
                        // 寻找主干列
                        if (text === '课程代码') codeIdx = j;
                        else if (text === '课程序号' && codeIdx === -1) codeIdx = j;

                        if (text === '操作') actionIdx = j;
                    }
                    // 只要在一行中同时找到了[课程代码/序号]和[操作]，就锁定这行
                    if (codeIdx !== -1 && actionIdx !== -1) {
                        headerRow = headRows[i];
                        break;
                    }
                }

                // 如果这根本不是一个课程列表表，直接略过
                if (!headerRow) return;

                // 关键逻辑修复：
                // 如果表头已经被我们修改过（翻页加载时），表头里的 actionIdx 会比原生行大 1。
                // 如果表头没被修改过（首次加载），两者严格相等。
                const rowActionIdx = wasHeaderInjected ? (actionIdx - 1) : actionIdx;

                // 步骤B：如果这个表格还没注入过“课程评价”的表头，先注入
                if (!wasHeaderInjected) {
                    const newTh = document.createElement(headerRow.children[0].tagName || 'th');
                    newTh.innerText = '课程评价';
                    newTh.setAttribute('width', '20%');
                    // 插在操作列的前面
                    headerRow.insertBefore(newTh, headerRow.children[actionIdx]);

                    // 打上标记，防止重复插入
                    table.setAttribute('data-cb-header', 'true');
                }

                // 步骤C：精确查找还没被处理过的数据行（适配下拉刷新和无刷新翻页）
                const dataRows = tbody.querySelectorAll('tr:not([data-cb-row])');
                if (dataRows.length === 0) return;

                let processedRowsCount = 0;

                dataRows.forEach(row => {
                    const cells = row.children;

                    // 防御性保护：处理教务系统中隐藏的占位空行
                    if (cells.length <= codeIdx || cells.length <= rowActionIdx) {
                        row.setAttribute('data-cb-row', 'ignored');
                        return;
                    }

                    // 提取课程代码，兼顾类似 "ARTS1206.01" 和纯 "ARTS1206"
                    let rawCode = (cells[codeIdx].textContent || '').trim();
                    let courseCode = rawCode.split('.')[0];
                    if (!courseCode) {
                        row.setAttribute('data-cb-row', 'ignored');
                        return;
                    }

                    const cbData = courseMap[courseCode];
                    // 动态抓取当前行的“操作”列状态
                    const actionText = (cells[rowActionIdx]?.textContent || '').trim();

                    let btnText = '查看评论';
                    let btnColor = '#007bff';

                    // 对无操作按钮（如已修、未开课等状态）切换为“发布评论”绿色样式
                    if (actionText === '' || actionText.includes('本轮选课未开课')) {
                        btnText = '发布评论';
                        btnColor = '#28a745';
                    }

                    const newTd = document.createElement('td');
                    newTd.style.textAlign = 'center';
                    newTd.style.verticalAlign = 'middle';

                    if (cbData) {
                        const scores = cbData.score || [0, 0, 0, 0];
                        const qlty = scores[0] ? scores[0].toFixed(1) : '-';
                        const hw = scores[1] ? scores[1].toFixed(1) : '-';
                        const diff = scores[2] ? scores[2].toFixed(1) : '-';
                        const grade = scores[3] ? scores[3].toFixed(1) : '-';

                        newTd.innerHTML = `
                            <div style="font-size: 11px; margin-bottom: 6px; line-height: 1.4; color: #333;">
                                质量:<span style="color:#d9534f;font-weight:bold">${qlty}</span> <br/>
                                作业:${hw} <br/>
                                考核:${diff} <br/>
                                给分:${grade} <br/>
                                <span style="color: #888;">(${cbData.comment_num}条)</span>
                            </div>
                            <a href="https://coursebench.org/course/${cbData.id}" target="_blank"
                               style="display: inline-block; padding: 3px 3px; background-color: ${btnColor}; color: white; border-radius: 4px; text-decoration: none; font-size: 12px; transition: 0.2s;">
                               ${btnText}
                            </a>
                        `;
                    } else {
                        newTd.innerHTML = `
                            <span style="color: #aaa; font-size: 12px; display:block; margin-bottom: 4px;">暂无评价</span>
                            <a href="https://coursebench.org/" target="_blank"
                               style="display: inline-block; padding: 3px 8px; background-color: #6c757d; color: white; border-radius: 4px; text-decoration: none; font-size: 12px;">
                               去提交
                            </a>
                        `;
                    }

                    // 准确定位，插入到正确的列之前
                    row.insertBefore(newTd, cells[rowActionIdx]);
                    // 打上已处理烙印，下一次扫描时不再重复计算
                    row.setAttribute('data-cb-row', 'true');
                    processedRowsCount++;
                });

                if (processedRowsCount > 0) {
                    console.log(`${LOG_PREFIX} 检测到数据变更，完成 ${processedRowsCount} 行评价加载。`);
                }
            });
        }, 1500);
    }

    // 启动主引擎
    fetchCourseData(0);

})();
