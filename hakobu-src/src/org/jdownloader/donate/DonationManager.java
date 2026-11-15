package org.jdownloader.donate;

/**
 * Hakobu: replaces JD's DonationManager. Hakobu shows no Contribute tab or button (JD's project can be supported directly at
 * jdownloader.org).
 */
public class DonationManager {
    private static final DonationManager INSTANCE = new DonationManager();

    private DonationManager() {
    }

    public static DonationManager getInstance() {
        return INSTANCE;
    }

    public boolean isButtonVisible() {
        return false;
    }
}
